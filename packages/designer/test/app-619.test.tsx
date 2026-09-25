import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { stubClient } from "./stub-server.js";

/**
 * #619 goto authoring on the canvas and in the pane (docs/spec/goto.md §9, designer-spec § goto): the
 * palette refuses a goto under a while-do or parallel, the block shows a chip instead of an edge, the
 * pane picks the target, and a rename of the target rewrites the goto in one undoable edit.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const PATH = "flows/main.workflow.json";

/** alpha · loop (while-do) · fan (parallel) · hop (goto → alpha, backward) · skip (goto → tail, forward) · tail. */
function gotoFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    body: [
      { type: "prompt", id: uuid(2), name: "alpha", prompt: "a", publish: { x: "${output.a}" } },
      { type: "while-do", id: uuid(3), name: "loop", condition: { type: "exists", path: "context.x" }, max_iterations: 2, node: { type: "prompt", id: uuid(4), name: "lb", prompt: "l" } },
      { type: "parallel", id: uuid(5), name: "fan", join: "collect", branches: [{ type: "prompt", id: uuid(6), name: "p1", prompt: "p" }] },
      { type: "goto", id: uuid(7), name: "hop", target: "alpha", max_jumps: 3 },
      { type: "goto", id: uuid(8), name: "skip", target: "tail", max_jumps: 2 },
      { type: "prompt", id: uuid(9), name: "tail", prompt: "t" },
    ],
  };
}

async function openCanvas() {
  render(<App client={stubClient({ files: { [PATH]: JSON.stringify(gotoFile()) } })} initialPath={PATH} />);
  await screen.findByText("alpha");
  const canvas = screen.getByRole("region", { name: "Workflow canvas" });
  const pane = screen.getByRole("region", { name: "Properties" });
  return { canvas, pane };
}

/** The block element of the node named `name`. */
function block(canvas: HTMLElement, name: string): HTMLElement {
  const nameSpan = within(canvas)
    .getAllByText(name)
    .find((el) => el.classList.contains("node-name"))!;
  return nameSpan.closest(".node-block") as HTMLElement;
}

function selectNode(canvas: HTMLElement, name: string): void {
  fireEvent.click(block(canvas, name));
}

describe("#619 G-D-01 palette placement", () => {
  it("opens no goto socket under a while-do or a parallel, and opens the file body's", async () => {
    const { canvas } = await openCanvas();
    fireEvent.click(screen.getByText("Goto"));
    expect(within(canvas).getByRole("button", { name: /add goto here/ })).toBeInTheDocument();
    expect(within(canvas).queryByRole("button", { name: /swap for goto/ })).not.toBeInTheDocument();
    expect(within(canvas).queryByRole("button", { name: /add goto branch/ })).not.toBeInTheDocument();

    fireEvent.click(within(canvas).getByRole("button", { name: /add goto here/ }));
    // The minted goto points nowhere yet: its chip says so and it carries a target-absent marker.
    expect(within(block(canvas, "goto")).getByText("→ (no target)")).toBeInTheDocument();
    expect(within(block(canvas, "goto")).getByRole("img", { name: /Validation error: goto target "" not found/ })).toBeInTheDocument();
  });
});

describe("#619 G-D-07 chip, highlight and incoming badge", () => {
  it("shows the target and a direction glyph on the goto block", async () => {
    const { canvas } = await openCanvas();
    expect(within(block(canvas, "hop")).getByText("→ alpha")).toBeInTheDocument();
    expect(within(block(canvas, "hop")).getByText("↑")).toBeInTheDocument();
    expect(within(block(canvas, "skip")).getByText("→ tail")).toBeInTheDocument();
    expect(within(block(canvas, "skip")).getByText("↓")).toBeInTheDocument();
  });

  it("badges each targeted first-level node with its incoming count, listing the gotos", async () => {
    const { canvas } = await openCanvas();
    const badge = within(block(canvas, "alpha")).getByText("← 1");
    expect(badge).toHaveAttribute("title", "Targeted by goto hop");
    expect(within(block(canvas, "tail")).getByText("← 1")).toBeInTheDocument();
    expect(within(block(canvas, "fan")).queryByText(/←/)).not.toBeInTheDocument();
  });

  it("highlights the target while its goto is selected or hovered", async () => {
    const { canvas } = await openCanvas();
    expect(block(canvas, "alpha")).not.toHaveAttribute("data-goto-target");
    selectNode(canvas, "hop");
    expect(block(canvas, "alpha")).toHaveAttribute("data-goto-target", "true");

    fireEvent.mouseEnter(block(canvas, "skip"));
    expect(block(canvas, "tail")).toHaveAttribute("data-goto-target", "true");
    fireEvent.mouseLeave(block(canvas, "skip"));
    expect(block(canvas, "tail")).not.toHaveAttribute("data-goto-target");
  });
});

describe("#619 G-D-06 the target picker", () => {
  it("lists first-level nodes in file order, self excluded, each marked forward or backward", async () => {
    const { canvas, pane } = await openCanvas();
    selectNode(canvas, "hop");
    const picker = within(pane).getByLabelText("target") as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      "↑ alpha",
      "↑ loop",
      "↑ fan",
      "↓ skip",
      "↓ tail",
    ]);
    expect(picker).toHaveValue("alpha");

    fireEvent.change(picker, { target: { value: "tail" } });
    expect(within(block(canvas, "hop")).getByText("→ tail")).toBeInTheDocument();
  });

  it("shows a missing target as `missing: <name>` without clearing it", async () => {
    const { canvas, pane } = await openCanvas();
    selectNode(canvas, "alpha");
    fireEvent.click(within(block(canvas, "alpha")).getByRole("button", { name: "Delete alpha" }));
    selectNode(canvas, "hop");
    const picker = within(pane).getByLabelText("target") as HTMLSelectElement;
    expect(picker).toHaveValue("alpha");
    expect(picker.selectedOptions[0]!.textContent).toBe("missing: alpha");
  });

  it("edits max_jumps beside the target", async () => {
    const { canvas, pane } = await openCanvas();
    selectNode(canvas, "skip");
    const field = within(pane).getByLabelText("max jumps");
    expect(field).toHaveValue("2");
    fireEvent.change(field, { target: { value: "5" } });
    expect(field).toHaveValue("5");
    expect(field).not.toHaveAttribute("aria-invalid", "true");
  });
});

describe("#619 G-D-04 / G-D-05 target edits", () => {
  it("rewrites every goto on a rename of its target, and one undo restores both", async () => {
    const { canvas, pane } = await openCanvas();
    selectNode(canvas, "alpha");
    fireEvent.change(within(pane).getByLabelText("name"), { target: { value: "first" } });
    expect(within(block(canvas, "hop")).getByText("→ first")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(within(canvas).getAllByText("alpha").length).toBeGreaterThan(0);
    expect(within(block(canvas, "hop")).getByText("→ alpha")).toBeInTheDocument();
  });

  it("allows deleting the target and marks the goto target-absent", async () => {
    const { canvas } = await openCanvas();
    fireEvent.click(within(block(canvas, "alpha")).getByRole("button", { name: "Delete alpha" }));
    expect(within(block(canvas, "hop")).getByRole("img", { name: /goto target "alpha" not found in this file/ })).toBeInTheDocument();
    expect(within(block(canvas, "hop")).queryByText("↑")).not.toBeInTheDocument();
  });
});
