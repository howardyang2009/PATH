import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { makeCalls, stubClient } from "./stub-server.js";

/**
 * #390 — new-file placement + naming. An author starts a workflow from scratch (no path, no lease until
 * the first save), builds a body on the empty canvas, and the first Save opens the placement dialog: a
 * directory picker confined to the project root, a suffix-enforced filename, and an exclusive create that
 * refuses an existing path rather than overwriting it. On success the path exists, the lease is acquired,
 * and launch enables.
 */

/** Discovery body giving the picker a real subdirectory beside the always-present project root. */
const DISCOVERY = { workflows: [{ relative_path: "flows/existing.workflow.json", id: null, name: null, valid: true, is_root: true, error: null }] };

/** Arm a palette entry, then place it into the empty body's tail socket — the smallest built body. */
function buildAPromptBody(): void {
  fireEvent.click(screen.getByText("Prompt"));
  const canvas = screen.getByRole("region", { name: "Workflow canvas" });
  fireEvent.click(within(canvas).getByRole("button", { name: /add prompt here/ }));
}

describe("#390 from-scratch buffer — no path, no lease until first save", () => {
  it("starts an empty buffer that takes no lease and cannot launch yet", async () => {
    const calls = makeCalls();
    render(<App client={stubClient({ calls })} />);

    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));

    // The empty-body affordance is on the canvas, and the buffer is dirty from open, so Save is live.
    await screen.findByRole("region", { name: "Start a body" });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    // No lease is taken for a never-saved buffer (it has no path to lock).
    await waitFor(() => expect(screen.getByRole("region", { name: "Workflow canvas" })).toBeInTheDocument());
    expect(calls.lock).toHaveLength(0);

    // Launch is gated on the first save — there is no path for the server to load.
    fireEvent.click(screen.getByTestId("run-dock-toggle"));
    expect(screen.getByTestId("run-launch-gate")).toHaveTextContent("Save this new workflow before you can run it.");
  });
});

describe("#390 first-save placement dialog", () => {
  it("prefills the name, enforces the .workflow.json suffix, and confines the directory to the root", async () => {
    render(<App client={stubClient({ workflows: DISCOVERY })} />);
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    buildAPromptBody();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", { name: "Save new workflow" });
    // Filename is prefilled from the workflow's name; the suffix is a fixed adornment, not editable text.
    expect(within(dialog).getByLabelText("Filename")).toHaveValue("untitled");
    expect(within(dialog).getByText(".workflow.json")).toBeInTheDocument();
    // The directory picker defaults to the project root and offers the discovered subdirectory.
    const directory = within(dialog).getByLabelText<HTMLSelectElement>("Directory");
    expect(directory.value).toBe("");
    expect(within(dialog).getByRole("option", { name: "(project root)" })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "flows" })).toBeInTheDocument());
    // A retyped stem keeps the enforced suffix in the composed target.
    fireEvent.change(within(dialog).getByLabelText("Filename"), { target: { value: "my-flow" } });
    expect(within(dialog).getByTestId("new-file-target")).toHaveTextContent("my-flow.workflow.json");
  });

  it("enforces the suffix without doubling it and keeps the directory picker the sole placement control", async () => {
    render(<App client={stubClient({ workflows: DISCOVERY })} />);
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    buildAPromptBody();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", { name: "Save new workflow" });
    fireEvent.change(within(dialog).getByLabelText("Directory"), { target: { value: "flows" } });
    // A stem that already carries the suffix must not double it.
    fireEvent.change(within(dialog).getByLabelText("Filename"), { target: { value: "my-flow.workflow.json" } });
    expect(within(dialog).getByTestId("new-file-target")).toHaveTextContent("flows/my-flow.workflow.json");
    // A stem cannot smuggle path separators past the directory picker.
    fireEvent.change(within(dialog).getByLabelText("Filename"), { target: { value: "../escape" } });
    expect(within(dialog).getByTestId("new-file-target")).toHaveTextContent("flows/escape.workflow.json");
  });

  it("creates the file with an exclusive PUT (no If-Match), then acquires the lease and enables launch", async () => {
    const calls = makeCalls();
    render(<App client={stubClient({ calls, workflows: DISCOVERY })} />);
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    buildAPromptBody();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", { name: "Save new workflow" });
    fireEvent.change(within(dialog).getByLabelText("Directory"), { target: { value: "flows" } });
    fireEvent.change(within(dialog).getByLabelText("Filename"), { target: { value: "my-flow" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    // The write is a create-only PUT: no If-Match precondition (ADR 0016), path composed under the root.
    await waitFor(() => expect(calls.put).toHaveLength(1));
    expect(calls.put[0]!.body.workflow_path).toBe("flows/my-flow.workflow.json");
    expect(calls.put[0]!.ifMatch).toBeNull();
    // The dialog closes on success and the save-point confirmation shows.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save new workflow" })).not.toBeInTheDocument());
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    // The lease is acquired for the freshly written path.
    await waitFor(() => expect(calls.lock.map((c) => c.workflow_path)).toContain("flows/my-flow.workflow.json"));
    // Launch behaves as for any saved file: the gate is gone and the run button is live.
    fireEvent.click(screen.getByTestId("run-dock-toggle"));
    expect(screen.queryByTestId("run-launch-gate")).not.toBeInTheDocument();
    expect(screen.getByTestId("run-launch-submit")).toBeEnabled();
  });

  it("refuses an existing path — choose another name — never a silent overwrite", async () => {
    const calls = makeCalls();
    // The server rejects a no-precondition create against an existing path with a 412 (ADR 0016).
    const onPut = (_b: unknown, ifMatch: string | null): Response =>
      ifMatch === null
        ? new Response(JSON.stringify({ error: { message: "exists" } }), { status: 412, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ relative_path: "x", id: "i", etag: '"e"' }), { status: 200, headers: { "Content-Type": "application/json" } });
    render(<App client={stubClient({ calls, onPut })} />);
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    buildAPromptBody();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", { name: "Save new workflow" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(await within(dialog).findByText(/already exists at that path/i)).toBeInTheDocument();
    // The dialog stays open, no save-point was reached, and the write carried no If-Match — never an overwrite.
    expect(screen.getByRole("dialog", { name: "Save new workflow" })).toBeInTheDocument();
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
    expect(calls.put.every((p) => p.ifMatch === null)).toBe(true);
  });
});
