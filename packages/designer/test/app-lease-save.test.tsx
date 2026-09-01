import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { makeCalls, stubClient } from "./stub-server.js";

/** A distinct valid UUIDv4 per seed. */
function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const ROOT_PATH = "flows/main.workflow.json";
const CHILD_PATH = "flows/sub/child.workflow.json";

function rootFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "root-flow",
    body: [
      { type: "prompt", id: uuid(2), name: "draft", prompt: "hi" },
      { type: "workflow", id: uuid(12), name: "sub", ref: "sub/child.workflow.json" },
    ],
  };
}

function childFile(): Record<string, unknown> {
  return { format: FORMAT_VERSION, id: uuid(40), name: "child-flow", body: [{ type: "prompt", id: uuid(41), name: "child-step", prompt: "deep" }] };
}

function filesWith(root: unknown): Record<string, string> {
  return { [ROOT_PATH]: JSON.stringify(root), [CHILD_PATH]: JSON.stringify(childFile()) };
}

describe("Designer edit-lock lease (#371)", () => {
  it("acquires the lease on open, before any edit, with a client-minted session_id", async () => {
    const calls = makeCalls();
    render(<App client={stubClient({ files: filesWith(rootFile()), calls })} initialPath={ROOT_PATH} />);

    await screen.findByText("draft");
    await waitFor(() => expect(calls.lock).toHaveLength(1));
    expect(calls.lock[0]).toMatchObject({ workflow_path: ROOT_PATH });
    expect(calls.lock[0]!.session_id).toMatch(/^[0-9a-f-]{36}$/);
    // A clean grant shows no takeover/lost banner.
    expect(screen.queryByText(/Another session is editing/)).not.toBeInTheDocument();
  });

  it("shows a confirmation-gated takeover on an acquire 409, then takes over with takeover:true", async () => {
    const calls = makeCalls();
    let first = true;
    const onLock = (): Response => {
      if (first) {
        first = false;
        return new Response(
          JSON.stringify({ error: { message: "held" }, held_by_other: true, expires_at: new Date(Date.now() + 25_000).toISOString() }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      const now = Date.now();
      return new Response(
        JSON.stringify({ session_id: "s", acquired_at: new Date(now).toISOString(), heartbeat_at: new Date(now).toISOString(), expires_at: new Date(now + 30_000).toISOString() }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    render(<App client={stubClient({ files: filesWith(rootFile()), calls, onLock })} initialPath={ROOT_PATH} />);

    await screen.findByText("draft");
    const banner = await screen.findByText(/Another session is editing/);
    // Countdown is rendered from the holder's expiry.
    expect(within(banner.closest(".lease-banner")!).getByText(/\d+s/)).toBeInTheDocument();

    // The takeover is gated behind an explicit confirm.
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm takeover" }));

    await waitFor(() => expect(calls.lock).toHaveLength(2));
    expect(calls.lock[1]).toMatchObject({ workflow_path: ROOT_PATH, takeover: true });
    await waitFor(() => expect(screen.queryByText(/Another session is editing/)).not.toBeInTheDocument());
  });

  it("takes a second, independent lease when descending into a ref'd file", async () => {
    const calls = makeCalls();
    render(<App client={stubClient({ files: filesWith(rootFile()), calls })} initialPath={ROOT_PATH} />);

    await screen.findByText("draft");
    await waitFor(() => expect(calls.lock).toHaveLength(1));
    fireEvent.doubleClick(screen.getByText("sub/child.workflow.json").closest('[role="button"]')!);

    await screen.findByText("child-step");
    await waitFor(() => expect(calls.lock.map((c) => c.workflow_path)).toEqual([ROOT_PATH, CHILD_PATH]));
    // Both leases beat under the same client-minted session.
    expect(calls.lock[1]!.session_id).toBe(calls.lock[0]!.session_id);
  });
});

describe("Designer save through the write route (#371)", () => {
  it("saves through PUT with the If-Match ETag and preserves every node id, clearing the dirty flag", async () => {
    const calls = makeCalls();
    // An id-less-but-valid file opens dirty (ids stamped on import) — so Save is enabled without an edit.
    const idless = rootFile();
    delete idless.id;
    delete (idless.body as Record<string, unknown>[])[0]!.id;
    render(<App client={stubClient({ files: filesWith(idless), calls })} initialPath={ROOT_PATH} />);

    await screen.findByText("draft");
    expect(screen.getByRole("status")).toHaveTextContent("stamped on import");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.put).toHaveLength(1));
    // The read ETag rides as If-Match (ADR 0016), and every node id is present in the saved bytes (ADR 0015).
    expect(calls.put[0]!.ifMatch).toBe('"stub"');
    const saved = calls.put[0]!.body.workflow;
    expect(typeof saved.id).toBe("string");
    for (const node of saved.body as Record<string, unknown>[]) {
      expect(typeof node.id).toBe("string");
    }
    // The buffer is now clean: "Saved." shows and the dirty badge is gone (the one clean save-point).
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(screen.queryByText(/stamped on import/)).not.toBeInTheDocument();
  });

  it("surfaces a 412 as a stale-write conflict the author must resolve, keeping the buffer", async () => {
    const idless = rootFile();
    delete idless.id;
    const onPut = (): Response =>
      new Response(JSON.stringify({ error: { message: "the file changed since it was read" } }), {
        status: 412,
        headers: { "Content-Type": "application/json" },
      });
    render(<App client={stubClient({ files: filesWith(idless), onPut })} initialPath={ROOT_PATH} />);

    await screen.findByText("draft");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByText(/changed on disk since you opened it/);
    expect(alert).toBeInTheDocument();
    // The buffer is not discarded — the canvas still holds the file.
    expect(screen.getByText("draft")).toBeInTheDocument();
    // Save is blocked while in conflict: re-sending the same stale ETag would only 412 again.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("recovers from a 412 by reloading the file, then saves against the fresh bytes", async () => {
    const idless = rootFile();
    delete idless.id; // opens dirty, so Save is enabled after each (re)load
    let putCount = 0;
    const onPut = (b: { workflow: Record<string, unknown> }): Response => {
      putCount += 1;
      if (putCount === 1) {
        return new Response(JSON.stringify({ error: { message: "the file changed since it was read" } }), {
          status: 412,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ relative_path: ROOT_PATH, id: b.workflow.id as string, etag: '"saved"' }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    render(<App client={stubClient({ files: filesWith(idless), onPut })} initialPath={ROOT_PATH} />);

    await screen.findByText("draft");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/changed on disk since you opened it/);

    // Reload discards the buffer for the on-disk bytes, clearing the conflict.
    fireEvent.click(screen.getByRole("button", { name: "Reload file" }));
    await waitFor(() => expect(screen.queryByText(/changed on disk since you opened it/)).not.toBeInTheDocument());

    // The reloaded (still id-less) file opens dirty again; a second save now succeeds.
    await screen.findByText("draft");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });
});
