import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { makeCalls, stubClient } from "./stub-server.js";

/**
 * #391 — nested `workflow`-ref creation (Model B). Adding a `workflow`-ref offers **reference-existing**
 * (a picker over discovered workflows) or **create-new**, which descends **at once** into a fresh,
 * unwritten, path-less child — no path is chosen up front. The child follows the from-scratch rule (no stub
 * written, no lease, no launch, until its first save), and ascending a dirty child never force-saves it.
 * The child's **first save** picks the path (the same new-file dialog a root takes) and **back-fills the
 * parent ref** from that path — so the ref is filled by the save, never chosen before authoring.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const PARENT_PATH = "flows/parent.workflow.json";

/** A saved parent file with a seed step, so the palette can place a fresh (empty-ref) `workflow` node into it. */
function parentFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "parent-flow",
    body: [{ type: "prompt", id: uuid(2), name: "seed", prompt: "x" }],
  };
}

/** Discovery giving the picker two existing workflows beside the parent, and the dialog its `flows` directory. */
const DISCOVERY = {
  workflows: [
    { relative_path: PARENT_PATH, id: uuid(1), name: "parent-flow", valid: true, is_root: true, error: null },
    { relative_path: "flows/other.workflow.json", id: uuid(9), name: "other", valid: true, is_root: false, error: null },
  ],
};

/** Open the parent, place a fresh (empty-ref) `workflow` node from the palette, and select it. */
async function openParentAndSelectRef(client = stubClient({ files: { [PARENT_PATH]: JSON.stringify(parentFile()) }, workflows: DISCOVERY })): Promise<void> {
  render(<App client={client} initialPath={PARENT_PATH} />);
  await screen.findByText("seed");
  // Arm the Workflow palette entry and drop it into the parent body's tail socket — a fresh, empty ref.
  fireEvent.click(screen.getByText("Workflow"));
  const canvas = screen.getByRole("region", { name: "Workflow canvas" });
  fireEvent.click(within(canvas).getByRole("button", { name: /add workflow here/ }));
  fireEvent.click((await within(canvas).findByText("workflow")).closest(".node-block") as HTMLElement);
}

/** Create-new from a selected empty ref node: descend at once into the fresh, path-less child's blank body. */
async function createNewChild(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Choose a reference target…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Create a new workflow" }));
  await screen.findByRole("region", { name: "Start a body" });
}

/** Save the active path-less child: click Save, then in the first-save dialog build `flows/child.workflow.json`. */
async function saveChildAs(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const dialog = await screen.findByRole("dialog", { name: "Save new workflow" });
  fireEvent.change(within(dialog).getByLabelText("Directory"), { target: { value: "flows" } });
  fireEvent.change(within(dialog).getByLabelText("Filename"), { target: { value: "child" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
}

/** Arm a Prompt and place it into the child's empty body — the smallest authored child. */
function buildAPromptBody(): void {
  fireEvent.click(screen.getByText("Prompt"));
  const canvas = screen.getByRole("region", { name: "Workflow canvas" });
  fireEvent.click(within(canvas).getByRole("button", { name: /add prompt here/ }));
}

describe("#391 adding a workflow-ref offers reference-existing or create-new", () => {
  it("shows the two-way chooser for an empty ref node", async () => {
    await openParentAndSelectRef();
    fireEvent.click(await screen.findByRole("button", { name: "Choose a reference target…" }));

    const dialog = await screen.findByRole("dialog", { name: "Add a workflow reference" });
    expect(within(dialog).getByRole("button", { name: "Reference an existing workflow" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create a new workflow" })).toBeInTheDocument();
  });

  it("double-clicking an unset workflow block opens the same chooser", async () => {
    await openParentAndSelectRef();
    // A fresh (empty-ref) block has nowhere to descend, so a double-click authors its target instead —
    // the same chooser the pane's "Choose a reference target…" opens.
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    const refChip = (await within(canvas).findByText("workflow")).closest(".node-block") as HTMLElement;
    fireEvent.doubleClick(refChip);

    const dialog = await screen.findByRole("dialog", { name: "Add a workflow reference" });
    expect(within(dialog).getByRole("button", { name: "Create a new workflow" })).toBeInTheDocument();
  });

  it("reference-existing sets the ref to a discovered workflow, relative to the parent", async () => {
    await openParentAndSelectRef();
    fireEvent.click(await screen.findByRole("button", { name: "Choose a reference target…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reference an existing workflow" }));

    const picker = await screen.findByRole("dialog", { name: "Reference an existing workflow" });
    fireEvent.click(await within(picker).findByRole("button", { name: "flows/other.workflow.json" }));

    // The chooser closes and the ref resolves to a path relative to the parent's own directory.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reference an existing workflow" })).not.toBeInTheDocument());
    const canvas = screen.getByRole("region", { name: "Workflow canvas" });
    expect(within(canvas).getByText("other.workflow.json")).toBeInTheDocument();
  });
});

describe("#391 create-new descends into a fresh, unwritten child", () => {
  it("writes no stub, descends into a dirty, path-less child that takes no lease and cannot launch", async () => {
    const calls = makeCalls();
    await openParentAndSelectRef(stubClient({ calls, files: { [PARENT_PATH]: JSON.stringify(parentFile()) }, workflows: DISCOVERY }));
    await waitFor(() => expect(calls.lock.map((c) => c.workflow_path)).toEqual([PARENT_PATH]));

    await createNewChild();

    // The breadcrumb crossed into the child at once; no path was chosen, so it reads "untitled", and no
    // stub file was written for it (no PUT).
    const crumbs = screen.getByRole("navigation", { name: "File breadcrumb" });
    expect(within(crumbs).getByText("parent-flow")).toBeInTheDocument();
    expect(within(crumbs).getByText("untitled")).toBeInTheDocument();
    expect(calls.put).toHaveLength(0);

    // The child reads dirty from open (Save is live) and takes no lease — the from-scratch rule.
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(calls.lock.map((c) => c.workflow_path)).toEqual([PARENT_PATH]);

    // Launch is gated until the child's first save — an unwritten child reads as a new, unsaved workflow.
    fireEvent.click(screen.getByTestId("run-dock-toggle"));
    expect(screen.getByTestId("run-launch-gate")).toHaveTextContent("Save this new workflow before you can run it.");
  });

  it("ascending a dirty child does not force-save; its buffer and breadcrumb survive", async () => {
    const calls = makeCalls();
    await openParentAndSelectRef(stubClient({ calls, files: { [PARENT_PATH]: JSON.stringify(parentFile()) }, workflows: DISCOVERY }));
    await createNewChild();
    buildAPromptBody();
    expect(await screen.findByText("prompt")).toBeInTheDocument();

    // Ascend to the parent via the breadcrumb — no save is forced.
    const crumbs = screen.getByRole("navigation", { name: "File breadcrumb" });
    fireEvent.click(within(crumbs).getByRole("button", { name: "parent-flow" }));
    expect(await screen.findByText("seed")).toBeInTheDocument();
    expect(calls.put).toHaveLength(0);

    // The breadcrumb returns to the child, whose dirty buffer (the authored prompt) is intact.
    fireEvent.click(within(crumbs).getByRole("button", { name: "untitled" }));
    expect(await screen.findByText("prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});

describe("#391 end-to-end — the child's save picks the path and back-fills the parent ref", () => {
  it("authors + saves the child (exclusive create, then leased), and the parent ref auto-fills from it", async () => {
    const calls = makeCalls();
    await openParentAndSelectRef(stubClient({ calls, files: { [PARENT_PATH]: JSON.stringify(parentFile()) }, workflows: DISCOVERY }));
    await createNewChild();
    buildAPromptBody();

    // Save the child: the path is chosen now, and the save is an exclusive create (no If-Match, ADR 0016).
    await saveChildAs();
    await waitFor(() => expect(calls.put).toHaveLength(1));
    expect(calls.put[0]!.body.workflow_path).toBe("flows/child.workflow.json");
    expect(calls.put[0]!.ifMatch).toBeNull();
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    // The lease is acquired for the freshly written child — the from-scratch rule lifts at the first save.
    await waitFor(() => expect(calls.lock.map((c) => c.workflow_path)).toContain("flows/child.workflow.json"));

    // Ascend and save the parent; its `workflow`-ref was back-filled by the child's save, relative to the parent.
    const crumbs = screen.getByRole("navigation", { name: "File breadcrumb" });
    fireEvent.click(within(crumbs).getByRole("button", { name: "parent-flow" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.put.some((p) => p.body.workflow_path === PARENT_PATH)).toBe(true));
    const parentPut = calls.put.find((p) => p.body.workflow_path === PARENT_PATH)!;
    const refNode = (parentPut.body.workflow.body as Record<string, unknown>[]).find((n) => n.type === "workflow")!;
    expect(refNode.ref).toBe("child.workflow.json");
  });
});
