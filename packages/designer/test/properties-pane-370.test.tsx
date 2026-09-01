import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { stubClient } from "./stub-server.js";

/** A distinct valid UUIDv4 per seed. */
function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const PATH = "flows/main.workflow.json";

/** A file exercising every #370 surface: config inheritance, conditions, an input, and a near-race publish. */
function paneFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    config: { region: "eu", timeout: 30 },
    body: [
      { type: "prompt", id: uuid(2), name: "alpha", prompt: "a", config: { region: "us" } },
      { type: "checkpoint", id: uuid(3), name: "gate", condition: { type: "exists", path: "context.x" } },
      {
        type: "while-do",
        id: uuid(4),
        name: "loop",
        condition: { type: "exists", path: "context.y" },
        max_iterations: 3,
        node: { type: "prompt", id: uuid(5), name: "loopbody", prompt: "l" },
      },
      {
        type: "branch",
        id: uuid(6),
        name: "br",
        arms: [{ when: { type: "exists", path: "context.z" }, node: { type: "prompt", id: uuid(7), name: "arm1", prompt: "1" } }],
      },
      {
        type: "parallel",
        id: uuid(8),
        name: "fan",
        join: "collect",
        branches: [
          { type: "prompt", id: uuid(9), name: "b1", prompt: "x", publish: { dup: "${output.a}" } },
          { type: "prompt", id: uuid(10), name: "b2", prompt: "y" },
        ],
      },
    ],
  };
}

async function openPane() {
  render(<App client={stubClient({ files: { [PATH]: JSON.stringify(paneFile()) } })} initialPath={PATH} />);
  await screen.findByText("alpha");
  const canvas = screen.getByRole("region", { name: "Workflow canvas" });
  const pane = screen.getByRole("region", { name: "Properties" });
  return { canvas, pane };
}

function selectNode(canvas: HTMLElement, name: string): void {
  const matches = within(canvas).getAllByText(name);
  const nameSpan = matches.find((el) => el.classList.contains("node-name")) ?? matches[0]!;
  fireEvent.click(nameSpan.closest(".node-block") as HTMLElement);
}

describe("#370 the typed condition builder", () => {
  it("authors a checkpoint assertion inside a labelled fieldset and commits a valid switch", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "gate");
    const fieldset = within(pane).getByRole("group", { name: "condition" });
    expect(within(fieldset).getByLabelText("Operator")).toHaveValue("exists");

    fireEvent.change(within(fieldset).getByLabelText("Operator"), { target: { value: "valid-json" } });
    // The canvas summary follows the committed assertion.
    expect(within(canvas).getByText(/assert valid-json context\.x/)).toBeInTheDocument();
  });

  it("makes an ill-typed condition unrepresentable — a bad root is flagged and not committed", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "gate");
    const path = within(pane).getByLabelText("path") as HTMLInputElement;
    // `config` is not a legal condition root; the draft is rejected and the canvas summary does not move.
    fireEvent.change(path, { target: { value: "config.x" } });
    expect(within(pane).getByRole("alert")).toBeInTheDocument();
    expect(within(canvas).getByText(/assert exists context\.x/)).toBeInTheDocument();
  });

  it("edits a while-do condition and a branch arm's when in a labelled fieldset", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "loop");
    expect(within(pane).getByRole("group", { name: "condition" })).toBeInTheDocument();
    expect(within(pane).getByLabelText("Max iterations")).toHaveValue(3);

    selectNode(canvas, "arm1");
    expect(within(pane).getByRole("note")).toHaveTextContent("branch arm (1 of 1)");
    const when = within(pane).getByRole("group", { name: "when" });
    fireEvent.change(within(when).getByLabelText("Operator"), { target: { value: "valid-json" } });
    expect(within(canvas).getByText(/when valid-json context\.z/)).toBeInTheDocument();
  });
});

describe("#370 config inheritance display", () => {
  it("shows inherited (ghosted + origin) and overridden (revert), and Override makes a key local", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    // `timeout` is inherited from the file; `region` is overridden by the step; `model` is a first-class field, not here.
    expect(within(pane).getByText("inherited from flow")).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Override" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Revert" })).toBeInTheDocument();

    fireEvent.click(within(pane).getByRole("button", { name: "Override" }));
    // Overriding the last inherited key removes the inherited caption.
    expect(within(pane).queryByText("inherited from flow")).not.toBeInTheDocument();
  });
});

describe("#370 input wiring", () => {
  it("live-checks the input object and rejects an unclosed placeholder", async () => {
    const { canvas, pane } = await openPane();
    selectNode(canvas, "alpha");
    const input = within(pane).getByLabelText(/Input object/) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '{ "q": "${context.a" }' } });
    expect(within(pane).getByRole("alert")).toHaveTextContent(/unclosed placeholder/);

    fireEvent.change(input, { target: { value: '{ "q": "${context.a}" }' } });
    expect(within(pane).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("#370 publish conflict marker", () => {
  it("marks a branch as a node validation error once an edit creates a collect same-key race", async () => {
    const { canvas, pane } = await openPane();
    // No conflict at open.
    expect(within(canvas).queryByRole("img", { name: /Validation error/ })).not.toBeInTheDocument();

    // Publish the same key `dup` from the second collect branch as the first already does.
    selectNode(canvas, "b2");
    fireEvent.click(within(pane).getByRole("button", { name: "+ add publish" }));
    fireEvent.change(within(pane).getByLabelText("Publish key"), { target: { value: "dup" } });

    expect(within(canvas).getByRole("img", { name: /Validation error/ })).toBeInTheDocument();
  });
});
