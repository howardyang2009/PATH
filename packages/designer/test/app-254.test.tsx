import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { stubClient } from "./stub-server.js";

/**
 * #254 — open an existing workflow from inside the app. The empty canvas offers "Open workflow" beside
 * "New workflow", and the toolbar offers "Open…" once a file is open; both raise a picker over the
 * project's discovered workflows (`GET /v0/workflows`). A choice opens that file through the same open
 * pipeline the `?path=` deep-link uses, so the author can pick up and edit any existing workflow.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const ALPHA_PATH = "flows/alpha.workflow.json";
const BETA_PATH = "flows/beta.workflow.json";

function fileNamed(id: number, name: string, stepName: string): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(id),
    name,
    body: [{ type: "prompt", id: uuid(id + 1), name: stepName, prompt: "hi" }],
  };
}

/** A discovery row as the server returns it — only `relative_path` steers the picker. */
function row(path: string): Record<string, unknown> {
  return { relative_path: path, id: null, name: null, valid: true, is_root: true, error: null };
}

const DISCOVERY = { workflows: [row(BETA_PATH), row(ALPHA_PATH)] };
const FILES = { [ALPHA_PATH]: JSON.stringify(fileNamed(1, "alpha-flow", "alpha-step")), [BETA_PATH]: JSON.stringify(fileNamed(3, "beta-flow", "beta-step")) };

describe("#254 open existing — empty-canvas entry point", () => {
  it("offers Open workflow beside New workflow on the empty canvas", async () => {
    render(<App client={stubClient()} />);
    expect(await screen.findByRole("button", { name: "Open workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New workflow" })).toBeInTheDocument();
  });

  it("lists discovered workflows in the picker, sorted, and opens the chosen one", async () => {
    render(<App client={stubClient({ files: FILES, workflows: DISCOVERY })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open workflow" }));

    const dialog = await screen.findByRole("dialog", { name: "Open a workflow" });
    const list = within(dialog).getByRole("list", { name: "Discovered workflows" });
    // Discovery returned beta-before-alpha; the picker sorts, so alpha lists first.
    const items = within(list).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([ALPHA_PATH, BETA_PATH]);

    fireEvent.click(within(dialog).getByRole("button", { name: BETA_PATH }));

    // The chosen file opens on the canvas and the picker closes.
    await screen.findByText("beta-step");
    expect(screen.getByRole("region", { name: "Workflow canvas" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Open a workflow" })).not.toBeInTheDocument();
  });

  it("shows a no-workflows note when discovery is empty, and cancel dismisses the picker", async () => {
    render(<App client={stubClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open workflow" }));

    const dialog = await screen.findByRole("dialog", { name: "Open a workflow" });
    expect(await within(dialog).findByText("No workflows discovered in this project yet.")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Open a workflow" })).not.toBeInTheDocument());
    // Still on the empty canvas — cancel opened nothing.
    expect(screen.getByText("Empty canvas")).toBeInTheDocument();
  });
});

describe("#254 open existing — toolbar entry point switches the open file", () => {
  it("opens the picker from the toolbar and swaps the active workflow", async () => {
    render(<App client={stubClient({ files: FILES, workflows: DISCOVERY })} initialPath={ALPHA_PATH} />);

    // Start on alpha via the deep-link.
    await screen.findByText("alpha-step");
    fireEvent.click(screen.getByRole("button", { name: "Open…" }));

    const dialog = await screen.findByRole("dialog", { name: "Open a workflow" });
    fireEvent.click(within(dialog).getByRole("button", { name: BETA_PATH }));

    // Beta replaces alpha as the sole root frame.
    await screen.findByText("beta-step");
    expect(screen.queryByText("alpha-step")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Open a workflow" })).not.toBeInTheDocument();
  });
});
