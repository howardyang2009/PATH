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

/** A file with a plain step, a parallel (2 branches), a branch (2 arms + else), and a while-do. */
function editableFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    body: [
      { type: "prompt", id: uuid(2), name: "alpha", prompt: "a" },
      { type: "prompt", id: uuid(3), name: "beta", prompt: "b" },
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
      { type: "while-do", id: uuid(11), name: "loop", condition: { type: "exists", path: "context.z" }, max_iterations: 2, node: { type: "prompt", id: uuid(12), name: "body", prompt: "l" } },
    ],
  };
}

function files(root: unknown): Record<string, string> {
  return { [PATH]: JSON.stringify(root) };
}

/** Arm a palette entry by its label (a click bubbles to the card button). */
function arm(label: string): void {
  fireEvent.click(screen.getByText(label));
}

async function openEditable() {
  render(<App client={stubClient({ files: files(editableFile()) })} initialPath={PATH} />);
  await screen.findByText("alpha");
  return screen.getByRole("region", { name: "Workflow canvas" });
}

describe("#368 add — a block snaps only into a grammar-legal socket", () => {
  it("adds a step at a legal list socket and refuses a checkpoint at an illegal one", async () => {
    const canvas = await openEditable();

    // Arm a prompt: the file body's tail socket opens; place a node.
    arm("Prompt");
    fireEvent.click(within(canvas).getByRole("button", { name: /add prompt here/ }));
    expect(within(canvas).getByText("prompt")).toBeInTheDocument(); // the minted node's default name

    // Arm a checkpoint: the file body (a sequence list) opens, but a parallel branch list does not
    // (checkpoint is unsnappable there) and neither does a single slot.
    arm("Checkpoint");
    expect(within(canvas).getByRole("button", { name: /add checkpoint here/ })).toBeInTheDocument();
    expect(within(canvas).queryByRole("button", { name: /add checkpoint branch/ })).not.toBeInTheDocument();
    expect(within(canvas).queryByRole("button", { name: /swap for checkpoint/ })).not.toBeInTheDocument();
  });

  it("opens a parallel branch socket for a legal kind", async () => {
    const canvas = await openEditable();
    arm("Prompt");
    expect(within(canvas).getByRole("button", { name: /add prompt branch/ })).toBeInTheDocument();
  });
});

describe("#368 reorder — within a container, preserving structure", () => {
  it("moves a top-level node down", async () => {
    const canvas = await openEditable();
    const names = () => within(canvas).getByRole("list").querySelectorAll(":scope > li > .node-block .node-name");
    fireEvent.click(within(canvas).getByRole("button", { name: "Move alpha down" }));
    const order = [...names()].map((el) => el.textContent);
    expect(order.slice(0, 2)).toEqual(["beta", "alpha"]);
  });
});

describe("#368 replace — a single-node slot swaps, never empties", () => {
  it("swaps a while-do body occupant for the armed kind", async () => {
    const canvas = await openEditable();
    arm("Binary");
    // Arming a single-legal kind opens every single slot; swap the one inside the while-do block.
    const loopBlock = within(canvas).getByText("loop").closest(".c-block") as HTMLElement;
    fireEvent.click(within(loopBlock).getByRole("button", { name: /swap for binary/ }));
    // The former body ("body") is gone; a COMMAND leaf took its slot.
    expect(within(loopBlock).queryByText("body")).not.toBeInTheDocument();
    expect(within(loopBlock).getByText("COMMAND")).toBeInTheDocument();
  });
});

describe("#368 delete — the slot rules hold", () => {
  it("deletes a while-do body, which deletes the whole loop", async () => {
    const canvas = await openEditable();
    fireEvent.click(within(canvas).getByRole("button", { name: "Delete body" }));
    expect(within(canvas).queryByText("loop")).not.toBeInTheDocument();
  });

  it("offers no delete for the last arm of a branch (must keep >=1)", async () => {
    const canvas = await openEditable();
    // Two arms → both deletable.
    fireEvent.click(within(canvas).getByRole("button", { name: "Delete arm2" }));
    // arm1 is now the last arm → its delete affordance is gone.
    expect(within(canvas).queryByRole("button", { name: "Delete arm1" })).not.toBeInTheDocument();
  });

  it("removes an else, then offers add-else again (at most one else)", async () => {
    const canvas = await openEditable();
    fireEvent.click(within(canvas).getByRole("button", { name: "Delete els" }));
    expect(within(canvas).queryByText("els")).not.toBeInTheDocument();
    expect(within(canvas).getByRole("button", { name: "+ add else" })).toBeInTheDocument();
  });
});

describe("#368 identity — a duplicate gets a fresh node", () => {
  it("duplicates a top-level node in place", async () => {
    const canvas = await openEditable();
    fireEvent.click(within(canvas).getByRole("button", { name: "Duplicate alpha" }));
    expect(within(canvas).getByText("alpha-copy")).toBeInTheDocument();
  });
});

describe("#368 empty canvas — a start-a-body affordance", () => {
  it("empties the body then seeds it from the palette", async () => {
    const canvas = await openEditable();
    // Delete every top-level node.
    for (const name of ["alpha", "beta", "fan", "gate", "loop"]) {
      fireEvent.click(within(canvas).getByRole("button", { name: `Delete ${name}` }));
    }
    expect(screen.getByRole("region", { name: "Start a body" })).toBeInTheDocument();
    arm("Sequence");
    fireEvent.click(screen.getByRole("button", { name: /add sequence here/ }));
    // The seeded sequence renders (its kind-tag and its node name both read "sequence").
    expect(within(canvas).getAllByText("sequence").length).toBeGreaterThan(0);
  });
});
