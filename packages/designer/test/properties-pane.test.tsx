import { FORMAT_VERSION, type WireStepPlugin } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { makeCalls, stubClient } from "./stub-server.js";

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
  { name: "prompt", fields: { prompt: { type: "string", optional: false } }, workers: ["anthropic", "batch"], default_worker: "anthropic" },
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

/** Expand one pane section by its header title — every region opens collapsed. */
function openSection(pane: HTMLElement, title: string): void {
  fireEvent.click(within(pane).getByRole("button", { name: title }));
}

describe("#369 selection populates the pane", () => {
  it("keeps name and id always shown, opens the kind fields expanded, and the payload regions collapsed", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");

    // Identity is the anchor: no header to open, and it stays put.
    expect(within(pane).getByLabelText("name")).toHaveValue("alpha");
    expect(within(pane).getByText(uuid(2))).toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "identity" })).toBeNull();
    // The kind's own fields open expanded — they are the pane's ordinary business.
    expect(within(pane).getByLabelText("prompt")).toBeInTheDocument();
    // The payload regions behind them are collapsed: their bodies are not in the document at all.
    expect(within(pane).queryByLabelText("New config key")).toBeNull();
    expect(within(pane).queryByLabelText(/^input \(/)).toBeNull();
    expect(within(pane).queryByRole("button", { name: "+ add publish" })).toBeNull();

    // A header folds its own section, and only its own; identity is unaffected.
    openSection(pane, "prompt");
    expect(within(pane).queryByLabelText("prompt")).toBeNull();
    expect(within(pane).getByLabelText("name")).toHaveValue("alpha");
    openSection(pane, "config");
    expect(within(pane).getByLabelText("New config key")).toBeInTheDocument();
    expect(within(pane).queryByLabelText(/^input \(/)).toBeNull();

    // A new selection resets every section to its default: fields open, payload regions collapsed.
    selectNode(canvas, "runner");
    expect(within(pane).getByLabelText("name")).toHaveValue("runner");
    expect(within(pane).getByLabelText("command")).toBeInTheDocument();
    expect(within(pane).queryByLabelText("New config key")).toBeNull();
  });

  it("shows explanation → name → id → kind fields for a selected step", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    expect(within(pane).getByText(/An LLM prompt/)).toBeInTheDocument();
    expect((within(pane).getByLabelText("name") as HTMLInputElement).value).toBe("alpha");
    expect(within(pane).getByText(uuid(2))).toBeInTheDocument();
    expect(within(pane).getByLabelText("prompt")).toBeInTheDocument();
  });

  it("offers the prompt type's model workers behind a leading effective-default option", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");

    // `RICH_PLUGINS` gives `prompt` two workers, so the generic worker selector renders. A leading
    // empty-value option is the un-pinned "(default)" case, naming the effective resolution and its
    // tier; the concrete workers follow (ADR 0044, #505).
    const select = within(pane).getByLabelText("worker") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "anthropic", "batch"]);
    expect(select.options[0]!.textContent).toBe("(default: anthropic — type)");
  });

  it("pins `worker` when a worker is picked, and drops the key when the (default) option is chosen", async () => {
    const calls = makeCalls();
    render(<App client={stubClient({ files: { [PATH]: JSON.stringify(paneFile()) }, plugins: RICH_PLUGINS, calls })} initialPath={PATH} />);
    await screen.findByText("alpha");
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    const pane = screen.getByRole("region", { name: "Properties" });
    selectNode(canvas, "alpha");

    // A step that names no worker renders as the leading "(default)" option — value empty, not the type default.
    expect((within(pane).getByLabelText("worker") as HTMLSelectElement).value).toBe("");

    fireEvent.change(within(pane).getByLabelText("worker"), { target: { value: "batch" } });
    expect((within(pane).getByLabelText("worker") as HTMLSelectElement).value).toBe("batch");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.put.length).toBe(1));
    const saved = calls.put.at(-1)!.body.workflow as { body: { name: string; worker?: string }[] };
    expect(saved.body.find((n) => n.name === "alpha")!.worker).toBe("batch");

    // Choosing "(default)" (the empty-value option) drops the key, so the step is identical to one that never named a worker.
    fireEvent.change(within(pane).getByLabelText("worker"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.put.length).toBe(2));
    const reSaved = calls.put.at(-1)!.body.workflow as { body: { name: string; worker?: string }[] };
    expect(reSaved.body.find((n) => n.name === "alpha")).not.toHaveProperty("worker");
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
    expect((within(pane).getByLabelText("name") as HTMLInputElement).value).toBe("flow");
    expect(within(pane).getByText(FORMAT_VERSION)).toBeInTheDocument();
  });

  it("clicking the workflow-name crumb goes back to the file's own properties", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    expect((within(pane).getByLabelText("name") as HTMLInputElement).value).toBe("alpha");
    // Click the current breadcrumb crumb (the open workflow's name) → deselect → file properties.
    fireEvent.click(within(canvas).getByRole("button", { name: "flow", current: "page" }));
    expect((within(pane).getByLabelText("name") as HTMLInputElement).value).toBe("flow");
    expect(within(pane).getByText(FORMAT_VERSION)).toBeInTheDocument();
  });

  it("keeps the selection through a structure-control click (not a background click)", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    // Reorder the selected node — a control-button click bubbles to the canvas but must not deselect.
    fireEvent.click(within(canvas).getByRole("button", { name: "Move alpha down" }));
    expect((within(pane).getByLabelText("name") as HTMLInputElement).value).toBe("alpha");
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
    expect((within(pane).getByLabelText("name") as HTMLInputElement).value).toBe("alpha");
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
    expect(within(pane).getByLabelText("model")).toBeInTheDocument();
    expect(within(pane).getByLabelText("prompt")).toBeInTheDocument();

    selectNode(canvas, "runner");
    expect((within(pane).getByLabelText("command") as HTMLInputElement).value).toBe("ls");
    expect(within(pane).getByLabelText(/args/)).toBeInTheDocument();
    expect((within(pane).getByLabelText("cwd") as HTMLInputElement).value).toBe("/tmp");

    selectNode(canvas, "sub");
    expect((within(pane).getByLabelText("referenced file") as HTMLInputElement).value).toBe("other.workflow.json");
  });

  it("authors workflow-level config on the file, and steps inherit it", async () => {
    const { canvas, pane } = await openPane();
    // Empty-canvas click → the file's own properties, which now carry a Config region.
    fireEvent.click(canvas.querySelector(".canvas-body") as HTMLElement);
    expect((within(pane).getByLabelText("name") as HTMLInputElement).value).toBe("flow");
    openSection(pane, "config");
    expect(within(pane).getByText(/Add a key to set a workflow default/)).toBeInTheDocument();

    // Add a workflow-level key and give it a value.
    fireEvent.change(within(pane).getByLabelText("New config key"), { target: { value: "region" } });
    fireEvent.click(within(pane).getByRole("button", { name: "+ add config key" }));
    fireEvent.change(within(pane).getByLabelText("region"), { target: { value: "eu" } });

    // A step now shows that key as inherited from the file: a ghosted value with an Override button.
    selectNode(canvas, "alpha");
    openSection(pane, "config");
    const regionRow = within(pane).getByText("region").closest(".pane-config-row") as HTMLElement;
    expect(within(regionRow).getByText("eu")).toHaveClass("pane-ghost");
    expect(within(regionRow).getByRole("button", { name: "Override" })).toBeInTheDocument();
  });

  it("ghosts the workflow's inherited model in a prompt's own model field", async () => {
    // A file whose config sets a workflow-default model; the prompt step declares none of its own.
    const file = { ...paneFile(), config: { model: "claude-sonnet-5" } };
    render(<App client={stubClient({ files: { [PATH]: JSON.stringify(file) }, plugins: RICH_PLUGINS })} initialPath={PATH} />);
    await screen.findByText("alpha");
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    const pane = screen.getByRole("region", { name: "Properties" });

    selectNode(canvas, "alpha");
    const model = within(pane).getByLabelText("model") as HTMLInputElement;
    // The field is empty (no own model) but ghosts the inherited value as a placeholder.
    expect(model.value).toBe("");
    expect(model.placeholder).toBe("claude-sonnet-5");
    expect(model).toHaveClass("pane-input-inherit");

    // Typing overrides: the field becomes solid (no inherit ghost) and holds the local value.
    model.focus();
    fireEvent.change(model, { target: { value: "claude-opus-4-8" } });
    const overridden = within(pane).getByLabelText("model") as HTMLInputElement;
    expect(overridden.value).toBe("claude-opus-4-8");
    expect(overridden).not.toHaveClass("pane-input-inherit");
    // The Revert appears without re-parenting the input, so it is the same node and keeps focus —
    // the author types on without the field dropping their cursor after the first character.
    expect(within(pane).getByRole("button", { name: "Revert" })).toBeInTheDocument();
    expect(overridden).toBe(model);
    expect(document.activeElement).toBe(model);

    // Revert drops the local model and restores the inherited ghost.
    fireEvent.click(within(pane).getByRole("button", { name: "Revert" }));
    const reverted = within(pane).getByLabelText("model") as HTMLInputElement;
    expect(reverted.value).toBe("");
    expect(reverted.placeholder).toBe("claude-sonnet-5");
    expect(reverted).toHaveClass("pane-input-inherit");
  });

  it("fills a field's placeholder on Tab, and leaves a filled field's Tab alone", async () => {
    const file = { ...paneFile(), config: { model: "claude-sonnet-5" } };
    render(<App client={stubClient({ files: { [PATH]: JSON.stringify(file) }, plugins: RICH_PLUGINS })} initialPath={PATH} />);
    await screen.findByText("alpha");
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    const pane = screen.getByRole("region", { name: "Properties" });

    // An empty field ghosting the inherited model: Tab takes the placeholder as the value (an override).
    selectNode(canvas, "alpha");
    const model = within(pane).getByLabelText("model") as HTMLInputElement;
    expect(model.value).toBe("");
    fireEvent.keyDown(model, { key: "Tab" });
    const filled = within(pane).getByLabelText("model") as HTMLInputElement;
    expect(filled.value).toBe("claude-sonnet-5");
    expect(filled).not.toHaveClass("pane-input-inherit");

    // A field that already holds text shows no placeholder, so Tab is left to move focus (value stays).
    fireEvent.change(filled, { target: { value: "claude-opus-4-8" } });
    fireEvent.keyDown(filled, { key: "Tab" });
    expect((within(pane).getByLabelText("model") as HTMLInputElement).value).toBe("claude-opus-4-8");
  });

  it("generates a form for a layoutable registry type", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "call");
    expect((within(pane).getByLabelText("endpoint") as HTMLInputElement).value).toBe("http://x");
    expect((within(pane).getByLabelText("retries") as HTMLInputElement).value).toBe("2");
    // The generated form is not the raw-JSON floor.
    expect(within(pane).queryByLabelText("payload (JSON)")).not.toBeInTheDocument();
  });

  it("falls to the raw-JSON floor for an unlayoutable type and stays strict-valid on a bad draft", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "wid");
    const textarea = within(pane).getByLabelText("payload (JSON)") as HTMLTextAreaElement;
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
    expect(within(pane).queryByLabelText("worker")).not.toBeInTheDocument();
  });

  it("preselects the (default) option for a >1-worker type and pins the chosen worker", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha"); // prompt ships anthropic + batch
    const select = within(pane).getByLabelText("worker") as HTMLSelectElement;
    // Un-pinned: the leading "(default)" option, value empty.
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: "batch" } });
    expect((within(pane).getByLabelText("worker") as HTMLSelectElement).value).toBe("batch");
    // Choosing "(default)" (empty value) un-pins again.
    fireEvent.change(within(pane).getByLabelText("worker"), { target: { value: "" } });
    expect((within(pane).getByLabelText("worker") as HTMLSelectElement).value).toBe("");
  });
});

describe("#505 file worker-defaults", () => {
  it("hides the section when no type ships more than one worker", async () => {
    // A file whose only step type is `prompt` as the default registry ships it — one worker, nothing to
    // select, so the section (its header included) is not rendered at all.
    const file = { format: FORMAT_VERSION, id: uuid(1), name: "flow", body: [{ type: "prompt", id: uuid(2), name: "alpha", prompt: "a" }] };
    render(<App client={stubClient({ files: { [PATH]: JSON.stringify(file) } })} initialPath={PATH} />);
    await screen.findByText("alpha");
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    const pane = screen.getByRole("region", { name: "Properties" });
    fireEvent.click(canvas.querySelector(".canvas-body") as HTMLElement);

    expect(within(pane).queryByRole("button", { name: "worker defaults" })).toBeNull();
  });

  it("ghosts the file worker-default as the effective un-pinned resolution", async () => {
    const file = { ...paneFile(), worker_defaults: { prompt: "batch" } };
    render(<App client={stubClient({ files: { [PATH]: JSON.stringify(file) }, plugins: RICH_PLUGINS })} initialPath={PATH} />);
    await screen.findByText("alpha");
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    const pane = screen.getByRole("region", { name: "Properties" });
    selectNode(canvas, "alpha");

    // An un-pinned step resolves to the file default now, so the "(default)" option names it and its tier.
    const select = within(pane).getByLabelText("worker") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.options[0]!.textContent).toBe("(default: batch — file)");
  });

  it("authors a file worker-default from the file properties and writes it on save", async () => {
    const calls = makeCalls();
    render(<App client={stubClient({ files: { [PATH]: JSON.stringify(paneFile()) }, plugins: RICH_PLUGINS, calls })} initialPath={PATH} />);
    await screen.findByText("alpha");
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    const pane = screen.getByRole("region", { name: "Properties" });

    // Empty-canvas click → the file's own properties, which carry the worker-defaults region.
    fireEvent.click(canvas.querySelector(".canvas-body") as HTMLElement);
    openSection(pane, "worker defaults");
    fireEvent.click(within(pane).getByRole("button", { name: "+ add worker default" }));

    // The only multi-worker type is `prompt`, added with its default worker; a constrained retarget to `batch`.
    expect((within(pane).getByLabelText("type") as HTMLSelectElement).value).toBe("prompt");
    expect((within(pane).getByLabelText("worker") as HTMLSelectElement).value).toBe("anthropic");
    fireEvent.change(within(pane).getByLabelText("worker"), { target: { value: "batch" } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.put.length).toBe(1));
    expect(calls.put.at(-1)!.body.workflow.worker_defaults).toEqual({ prompt: "batch" });
  });

  it("reads an existing worker_defaults row back and drops the key when the last row is removed", async () => {
    const calls = makeCalls();
    const file = { ...paneFile(), worker_defaults: { prompt: "batch" } };
    render(<App client={stubClient({ files: { [PATH]: JSON.stringify(file) }, plugins: RICH_PLUGINS, calls })} initialPath={PATH} />);
    await screen.findByText("alpha");
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    const pane = screen.getByRole("region", { name: "Properties" });
    fireEvent.click(canvas.querySelector(".canvas-body") as HTMLElement);
    openSection(pane, "worker defaults");

    // The stored map reads back into a constrained row.
    expect((within(pane).getByLabelText("type") as HTMLSelectElement).value).toBe("prompt");
    expect((within(pane).getByLabelText("worker") as HTMLSelectElement).value).toBe("batch");

    // Removing the last row drops the whole key, so `worker_defaults: {}` never lands.
    fireEvent.click(within(pane).getByRole("button", { name: "Remove this worker default" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.put.length).toBe(1));
    expect(calls.put.at(-1)!.body.workflow).not.toHaveProperty("worker_defaults");
  });
});

describe("the workflow-level output object (§6.4)", () => {
  it("authors an output map on the file and writes it on save", async () => {
    const calls = makeCalls();
    render(<App client={stubClient({ calls, files: { [PATH]: JSON.stringify(paneFile()) }, plugins: RICH_PLUGINS })} initialPath={PATH} />);
    await screen.findByText("alpha");
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    const pane = screen.getByRole("region", { name: "Properties" });

    // Empty-canvas click → the file's own properties, which carry the output region.
    fireEvent.click(canvas.querySelector(".canvas-body") as HTMLElement);
    openSection(pane, "output");
    fireEvent.click(within(pane).getByRole("button", { name: "+ add output key" }));

    // Before a key is typed the value placeholder falls back to ${context.key}.
    expect((within(pane).getByLabelText("Output value") as HTMLInputElement).placeholder).toBe("${context.key}");

    // The placeholder tracks the key: keying "notes" makes it ${context.notes}.
    fireEvent.change(within(pane).getByLabelText("Output key"), { target: { value: "notes" } });
    expect((within(pane).getByLabelText("Output value") as HTMLInputElement).placeholder).toBe("${context.notes}");

    // An ill-typed interpolation is flagged and does not reach the file.
    fireEvent.change(within(pane).getByLabelText("Output value"), { target: { value: "${output.x}" } });
    expect(within(pane).getByLabelText("Output value")).toBeInvalid();

    // A valid value over the output roots (config/context) commits.
    fireEvent.change(within(pane).getByLabelText("Output value"), { target: { value: "${context.draft}" } });
    expect(within(pane).getByLabelText("Output value")).toBeValid();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.put).toHaveLength(1));
    expect(calls.put[0]!.body.workflow.output).toEqual({ notes: "${context.draft}" });
  });

  it("reads an existing output map back into rows", async () => {
    const file = { ...paneFile(), output: { verdict: "${context.verdict}" } };
    render(<App client={stubClient({ files: { [PATH]: JSON.stringify(file) }, plugins: RICH_PLUGINS })} initialPath={PATH} />);
    await screen.findByText("alpha");
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    const pane = screen.getByRole("region", { name: "Properties" });

    fireEvent.click(canvas.querySelector(".canvas-body") as HTMLElement);
    openSection(pane, "output");
    expect((within(pane).getByLabelText("Output key") as HTMLInputElement).value).toBe("verdict");
    expect((within(pane).getByLabelText("Output value") as HTMLInputElement).value).toBe("${context.verdict}");
  });
});

describe("#487 person-activity first-class editor + canvas identity", () => {
  const PERSON_PLUGINS: WireStepPlugin[] = [
    ...RICH_PLUGINS,
    {
      name: "person-activity",
      fields: {
        description: { type: "string", optional: false },
        outputSchema: { type: "object", optional: true },
        assignee: { type: "string", optional: true },
      },
      workers: ["person"],
      default_worker: "person",
    },
  ];

  /** A file with one `person-activity` leaf carrying all three fields. */
  function personFile(): Record<string, unknown> {
    return {
      format: FORMAT_VERSION,
      id: uuid(1),
      name: "flow",
      body: [
        {
          type: "person-activity",
          id: uuid(20),
          name: "review",
          description: "Review the draft {{context.title}}",
          outputSchema: { type: "object", properties: { approved: { type: "boolean" } } },
          assignee: "editor",
        },
      ],
    };
  }

  async function openPersonPane(calls?: ReturnType<typeof makeCalls>) {
    const client = stubClient({ calls, files: { [PATH]: JSON.stringify(personFile()) }, plugins: PERSON_PLUGINS });
    render(<App client={client} initialPath={PATH} />);
    await screen.findByText("review");
    return {
      client,
      canvas: screen.getByRole("region", { name: "Workflow canvas" }),
      pane: screen.getByRole("region", { name: "Properties" }),
    };
  }

  it("renders a teal person-activity block with the person glyph and a PERSON chip", async () => {
    const { canvas } = await openPersonPane();
    const block = within(canvas).getByText("review").closest(".node-block") as HTMLElement;
    expect(block).toHaveAttribute("data-node-type", "person-activity");
    expect(block.getAttribute("style")).toContain("--k-person");
    expect(within(canvas).getByTestId(`leaf-glyph-${uuid(20)}`)).toHaveTextContent("👤");
    expect(within(block).getByText("PERSON")).toBeInTheDocument();
  });

  it("exposes description, outputSchema, and assignee, seeded from the node", async () => {
    const { canvas, pane } = await openPersonPane();
    selectNode(canvas, "review");
    expect(within(pane).getByText(/person completes/)).toBeInTheDocument();
    expect((within(pane).getByLabelText("description") as HTMLTextAreaElement).value).toBe("Review the draft {{context.title}}");
    expect((within(pane).getByLabelText("assignee") as HTMLInputElement).value).toBe("editor");
    const schema = within(pane).getByLabelText(/outputSchema/) as HTMLTextAreaElement;
    expect(JSON.parse(schema.value)).toEqual({ type: "object", properties: { approved: { type: "boolean" } } });
  });

  it("commits an edited description and drops outputSchema when cleared", async () => {
    const calls = makeCalls();
    const { canvas, pane } = await openPersonPane(calls);
    selectNode(canvas, "review");

    fireEvent.change(within(pane).getByLabelText("description"), { target: { value: "New instructions" } });
    fireEvent.change(within(pane).getByLabelText(/outputSchema/), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.put).toHaveLength(1));
    const node = (calls.put[0]!.body.workflow.body as Record<string, unknown>[])[0]!;
    expect(node.description).toBe("New instructions");
    expect("outputSchema" in node).toBe(false);
  });

  it("keeps a strict-valid node when the outputSchema draft is invalid (never commits it)", async () => {
    const { canvas, pane } = await openPersonPane();
    selectNode(canvas, "review");
    const schema = within(pane).getByLabelText(/outputSchema/);
    fireEvent.change(schema, { target: { value: "{ not json" } });
    expect(schema).toBeInvalid();
    expect(within(pane).getByRole("alert")).toHaveTextContent(/Not valid JSON/);
  });
});
