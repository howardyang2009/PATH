import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { stubClient } from "./stub-server.js";

/**
 * The #389 keyboard surface: Backspace-delete (withheld before for want of an undo) is unlocked, and the
 * toolbar Undo restores it. This is the acceptance-criteria Backspace round-trip driven through the real
 * app, not the hook.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const PATH = "flows/main.workflow.json";

/** Two top-level steps, so either is a deletable list element. */
function twoStepFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    body: [
      { type: "prompt", id: uuid(2), name: "alpha", prompt: "a" },
      { type: "prompt", id: uuid(3), name: "beta", prompt: "b" },
    ],
  };
}

async function openApp() {
  render(<App client={stubClient({ files: { [PATH]: JSON.stringify(twoStepFile()) } })} initialPath={PATH} />);
  await screen.findByText("beta");
  return screen.getByRole("region", { name: "Workflow canvas" });
}

describe("#389 Backspace-delete is enabled and is undoable", () => {
  it("deletes a focused block on Backspace, then restores it on Undo", async () => {
    const canvas = await openApp();

    // Backspace on the focused block deletes it — no undo gate any more.
    const block = within(canvas).getByText("beta").closest(".node-block") as HTMLElement;
    fireEvent.keyDown(block, { key: "Backspace" });
    expect(within(canvas).queryByText("beta")).not.toBeInTheDocument();

    // The toolbar Undo brings it back — the destructive delete is one undo entry.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(within(canvas).getByText("beta")).toBeInTheDocument();
  });

  it("disables Undo until there is an edit, and Redo until there is an undo", async () => {
    const canvas = await openApp();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();

    const block = within(canvas).getByText("beta").closest(".node-block") as HTMLElement;
    fireEvent.keyDown(block, { key: "Backspace" });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });
});
