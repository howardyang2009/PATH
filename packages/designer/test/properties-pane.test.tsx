import { FORMAT_VERSION, type WireStepPlugin } from "@path/schema";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { stubClient } from "./stub-server.js";

/** A distinct valid UUIDv4 per seed. */
function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const PATH = "flows/main.workflow.json";

/** A file with a plain step, a parallel (2 branches), a branch (2 arms + else), and a generic + a raw-JSON leaf. */
function paneFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    body: [
      { type: "prompt", id: uuid(2), name: "alpha", prompt: "a" },
      { type: "binary", id: uuid(3), name: "runner", command: "ls", args: ["-l"], cwd: "/tmp" },
      { type: "workflow", id: uuid(13), name: "sub", ref: "other.workflow.json" },
      {
        type: "parallel",
        id: uuid(4),
        name: "fan",
        join: "collect",
        branches: [
          { type: "prompt", id: uuid(5), name: "p1", prompt: "x" },
          { type: "prompt", id: uuid(6), name: "p2", prompt: "y" },
        ],
      },
      {
        type: "branch",
        id: uuid(7),
        name: "gate",
        arms: [
          { when: { type: "exists", path: "context.x" }, node: { type: "prompt", id: uuid(8), name: "arm1", prompt: "1" } },
          { when: { type: "exists", path: "context.y" }, node: { type: "prompt", id: uuid(9), name: "arm2", prompt: "2" } },
        ],
        else: { type: "prompt", id: uuid(10), name: "els", prompt: "e" },
      },
      { type: "api-call", id: uuid(11), name: "call", endpoint: "http://x", retries: 2 },
      { type: "weird", id: uuid(12), name: "wid", shape: { a: 1 } },
    ],
  };
}

/** Registry with a multi-worker prompt, a layoutable generic type, and an unlayoutable (raw-JSON) type. */
const RICH_PLUGINS: WireStepPlugin[] = [
  { name: "prompt", fields: { prompt: { type: "string", optional: false } }, workers: ["sdk", "batch"], default_worker: "sdk" },
  {
    name: "binary",
    fields: {
      command: { type: "string", optional: false },
      args: { type: "array", optional: true, element: { type: "string", optional: false } },
      cwd: { type: "string", optional: true },
    },
    workers: ["spawn"],
    default_worker: "spawn",
  },
  {
    name: "api-call",
    fields: { endpoint: { type: "string", optional: false }, retries: { type: "number", optional: true } },
    workers: ["http"],
    default_worker: "http",
  },
  { name: "weird", fields: { shape: { type: "object", optional: false } }, workers: ["w"], default_worker: "w" },
];

async function openPane(plugins: WireStepPlugin[] = RICH_PLUGINS) {
  render(<App client={stubClient({ files: { [PATH]: JSON.stringify(paneFile()) }, plugins })} initialPath={PATH} />);
  await screen.findByText("alpha");
  const canvas = screen.getByRole("region", { name: "Workflow canvas" });
  const pane = screen.getByRole("region", { name: "Properties" });
  return { canvas, pane };
}

/**
 * Single-click the block that carries `name`. A parallel branch shows its name twice — once as the
 * column caption, once as the node's own `.node-name` — so target the `.node-name` span, then its
 * block (the name span is not a button, so the click selects rather than acts).
 */
function selectNode(canvas: HTMLElement, name: string): void {
  const matches = within(canvas).getAllByText(name);
  const nameSpan = matches.find((el) => el.classList.contains("node-name")) ?? matches[0]!;
  fireEvent.click(nameSpan.closest(".node-block") as HTMLElement);
}

describe("#369 selection populates the pane", () => {
  it("shows explanation → name → id → kind fields for a selected step", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    expect(within(pane).getByText(/An LLM prompt/)).toBeInTheDocument();
    expect((within(pane).getByLabelText("Name") as HTMLInputElement).value).toBe("alpha");
    expect(within(pane).getByText(uuid(2))).toBeInTheDocument();
    expect(within(pane).getByLabelText("Prompt")).toBeInTheDocument();
  });

  it("labels a branch arm, a branch else, and a parallel branch by role", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "arm1");
    expect(within(pane).getByRole("note")).toHaveTextContent("branch arm (1 of 2)");
    selectNode(canvas, "arm2");
    expect(within(pane).getByRole("note")).toHaveTextContent("branch arm (2 of 2)");
    selectNode(canvas, "els");
    expect(within(pane).getByRole("note")).toHaveTextContent("branch else fallback");
    selectNode(canvas, "p1");
    expect(within(pane).getByRole("note")).toHaveTextContent("parallel branch");
  });

  it("gives a top-level node no role, and an empty-canvas click shows the file's own properties", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    expect(within(pane).queryByRole("note")).not.toBeInTheDocument();
    // Click the scrolling canvas background (not a block) → deselect → file properties.
    fireEvent.click(canvas.querySelector(".canvas-body") as HTMLElement);
    expect((within(pane).getByLabelText("Name") as HTMLInputElement).value).toBe("flow");
    expect(within(pane).getByText(FORMAT_VERSION)).toBeInTheDocument();
  });

  it("keeps the selection through a structure-control click (not a background click)", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    // Reorder the selected node — a control-button click bubbles to the canvas but must not deselect.
    fireEvent.click(within(canvas).getByRole("button", { name: "Move alpha down" }));
    expect((within(pane).getByLabelText("Name") as HTMLInputElement).value).toBe("alpha");
  });
});

describe("#369 the id re-key is confirmation-gated", () => {
  it("re-keys only after Confirm, and keeps the node selected under its new id", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    expect(within(pane).getByText(uuid(2))).toBeInTheDocument();

    fireEvent.click(within(pane).getByRole("button", { name: "Re-key" }));
    // A warning and the confirm/cancel appear; the id has not changed yet.
    expect(within(pane).getByRole("alert")).toHaveTextContent(/breaks resume plan-reuse/);
    expect(within(pane).getByText(uuid(2))).toBeInTheDocument();

    fireEvent.click(within(pane).getByRole("button", { name: "Confirm re-key" }));
    // The id changed to a fresh UUID and the pane still edits the same node (its name survives).
    expect(within(pane).queryByText(uuid(2))).not.toBeInTheDocument();
    expect((within(pane).getByLabelText("Name") as HTMLInputElement).value).toBe("alpha");
  });

  it("cancels the re-key, leaving the id untouched", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    fireEvent.click(within(pane).getByRole("button", { name: "Re-key" }));
    fireEvent.click(within(pane).getByRole("button", { name: "Cancel" }));
    expect(within(pane).getByText(uuid(2))).toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "Confirm re-key" })).not.toBeInTheDocument();
  });
});

describe("#369 the three editor tiers", () => {
  it("uses the hand-built editors for prompt, binary, and workflow-ref", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    expect(within(pane).getByLabelText("Model")).toBeInTheDocument();
    expect(within(pane).getByLabelText("Prompt")).toBeInTheDocument();

    selectNode(canvas, "runner");
    expect((within(pane).getByLabelText("Command") as HTMLInputElement).value).toBe("ls");
    expect(within(pane).getByLabelText(/Args/)).toBeInTheDocument();
    expect((within(pane).getByLabelText("Cwd") as HTMLInputElement).value).toBe("/tmp");

    selectNode(canvas, "sub");
    expect((within(pane).getByLabelText("Referenced file") as HTMLInputElement).value).toBe("other.workflow.json");
  });

  it("generates a form for a layoutable registry type", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "call");
    expect((within(pane).getByLabelText("Endpoint") as HTMLInputElement).value).toBe("http://x");
    expect((within(pane).getByLabelText("Retries") as HTMLInputElement).value).toBe("2");
    // The generated form is not the raw-JSON floor.
    expect(within(pane).queryByLabelText("Payload (JSON)")).not.toBeInTheDocument();
  });

  it("falls to the raw-JSON floor for an unlayoutable type and stays strict-valid on a bad draft", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "wid");
    const textarea = within(pane).getByLabelText("Payload (JSON)") as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({ shape: { a: 1 } });

    // A malformed draft is flagged and not committed; the node on the canvas keeps its name.
    fireEvent.change(textarea, { target: { value: "{ not json" } });
    expect(within(pane).getByRole("alert")).toHaveTextContent(/Not valid JSON/);
    expect(within(canvas).getByText("wid")).toBeInTheDocument();

    // A valid draft clears the error.
    fireEvent.change(textarea, { target: { value: '{ "shape": { "a": 2 } }' } });
    expect(within(pane).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("#369 worker selection", () => {
  it("shows no worker control for a single-worker type", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "runner"); // binary ships one worker
    expect(within(pane).queryByLabelText("Worker")).not.toBeInTheDocument();
  });

  it("shows a default-preselected dropdown for a >1-worker type and writes the chosen worker", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha"); // prompt ships sdk + batch
    const select = within(pane).getByLabelText("Worker") as HTMLSelectElement;
    expect(select.value).toBe("sdk");
    fireEvent.change(select, { target: { value: "batch" } });
    expect((within(pane).getByLabelText("Worker") as HTMLSelectElement).value).toBe("batch");
    // Selecting the default again drops the field back to the default.
    fireEvent.change(within(pane).getByLabelText("Worker"), { target: { value: "sdk" } });
    expect((within(pane).getByLabelText("Worker") as HTMLSelectElement).value).toBe("sdk");
  });
});
