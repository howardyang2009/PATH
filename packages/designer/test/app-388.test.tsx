import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { openWorkflowFile } from "../src/open-workflow.js";
import { canonicalSerialize } from "../src/serialize.js";
import { DEFAULT_PLUGINS, makeCalls, stubClient } from "./stub-server.js";

/** The canonical on-disk bytes of a file — what a Designer save writes, so it opens clean (not dirty). */
function canonical(f: Record<string, unknown>): string {
  const opened = openWorkflowFile(JSON.stringify(f), DEFAULT_PLUGINS);
  if (opened.status !== "opened") throw new Error(opened.status);
  return canonicalSerialize(opened.file);
}

/** A distinct valid UUIDv4 per seed. */
function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const PATH = "flows/main.workflow.json";

/**
 * A file whose one step reads `${context.missing}` — a soft cross-node error (no step publishes
 * `missing`). Id-less, so it opens **dirty** (ids stamped on import), which enables Save without a UI
 * edit — the shape the "save is not blocked" criterion needs.
 */
function danglingFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    name: "flow",
    body: [{ type: "prompt", name: "reader", prompt: "use ${context.missing}" }],
  };
}

async function openApp(files: Record<string, string>, calls = makeCalls()) {
  render(<App client={stubClient({ files, calls })} initialPath={PATH} />);
  // "reader" appears twice (the node name and a problems-panel row), so wait on the node-name span.
  await screen.findByText("reader", { selector: ".node-name" });
  const canvas = screen.getByRole("region", { name: "Workflow canvas" });
  return { canvas, calls };
}

describe("#388 cross-node validation markers + problems panel", () => {
  it("marks the offending node and lists it in the problems panel", async () => {
    const { canvas } = await openApp({ [PATH]: JSON.stringify(danglingFile()) });

    // Per-node ⚠ marker.
    const marker = within(canvas).getByRole("img", { name: /Validation error/ });
    expect(marker).toHaveTextContent("⚠");

    // Aggregate panel with a row for the same node.
    const panel = screen.getByRole("region", { name: "Problems" });
    expect(within(panel).getByText(/no step in this file publishes/)).toBeInTheDocument();
    expect(within(panel).getByText("reader")).toBeInTheDocument();
  });

  it("jumps to the node from a panel row (selects it)", async () => {
    const { canvas } = await openApp({ [PATH]: JSON.stringify(danglingFile()) });
    const panel = screen.getByRole("region", { name: "Problems" });

    // The block is not selected until the panel row is clicked.
    const block = canvas.querySelector('[data-node-id]') as HTMLElement;
    expect(block.getAttribute("data-selected")).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: /^Jump to reader/ }));
    expect(block.getAttribute("data-selected")).toBe("true");
  });

  it("does not block save on a soft error — the PUT still succeeds", async () => {
    const { calls } = await openApp({ [PATH]: JSON.stringify(danglingFile()) });

    // Opens dirty (ids stamped), so Save is enabled despite the dangling read.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.put).toHaveLength(1));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();

    // The warning survives the save — a saved-with-warnings file is clean but still flagged.
    expect(screen.getByRole("region", { name: "Problems" })).toBeInTheDocument();
  });

  it("badges launch with the warning count, and still lets the run launch", async () => {
    // A canonical (clean) file so launch is not gated by the dirty flag — only badged by the warning.
    const clean = canonical({
      format: FORMAT_VERSION,
      id: uuid(1),
      name: "flow",
      body: [{ type: "prompt", id: uuid(2), name: "reader", prompt: "use ${context.missing}" }],
    });
    await openApp({ [PATH]: clean });

    fireEvent.click(screen.getByRole("button", { name: /Runs/ }));
    expect(screen.getByTestId("run-launch-warning-badge")).toHaveTextContent("⚠ 1");
    // Launch is enabled (badged, not blocked).
    expect(screen.getByTestId("run-launch-submit")).not.toBeDisabled();
  });

  it("shows no panel and no marker for a clean file", async () => {
    const clean = {
      format: FORMAT_VERSION,
      id: uuid(1),
      name: "flow",
      body: [
        { type: "prompt", id: uuid(2), name: "writer", prompt: "x", publish: { ready: "${output.a}" } },
        { type: "prompt", id: uuid(3), name: "reader", prompt: "use ${context.ready}" },
      ],
    };
    const { canvas } = await openApp({ [PATH]: JSON.stringify(clean) });
    expect(within(canvas).queryByRole("img", { name: /Validation error/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Problems" })).not.toBeInTheDocument();
  });
});
