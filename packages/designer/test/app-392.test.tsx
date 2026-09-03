import { FORMAT_VERSION } from "@path/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { openWorkflowFile } from "../src/open-workflow.js";
import { canonicalSerialize } from "../src/serialize.js";
import { DEFAULT_PLUGINS, stubClient, type DesignerStubOptions } from "./stub-server.js";

/**
 * #392 — launch warning badge + dangling-`workflow`-ref marker. A create-new child ref (#391) points the
 * parent at a path with no file yet; that transient state surfaces as a per-node ⚠ and a problems-panel
 * row, badges (never blocks) launch, and clears when the child's first save makes discovery list it.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const PARENT_PATH = "flows/parent.workflow.json";
const CHILD_PATH = "flows/child.workflow.json";

/** A parent whose one `workflow` node refs `child.workflow.json` (resolves to `flows/child.workflow.json`). */
function parentFile(withId: boolean): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    ...(withId ? { id: uuid(1) } : {}),
    name: "parent",
    body: [{ type: "workflow", ...(withId ? { id: uuid(2) } : {}), name: "child", ref: "child.workflow.json" }],
  };
}

/** The canonical on-disk bytes — what a save writes, so the file opens clean (launch not dirty-gated). */
function canonical(f: Record<string, unknown>): string {
  const opened = openWorkflowFile(JSON.stringify(f), DEFAULT_PLUGINS);
  if (opened.status !== "opened") throw new Error(opened.status);
  return canonicalSerialize(opened.file);
}

/** A discovery summary row for a path (only `relative_path` matters to the dangling-ref check). */
function summary(relativePath: string) {
  return { relative_path: relativePath, id: null, name: null, valid: true, is_root: null, error: null };
}

async function openParent(options: DesignerStubOptions) {
  render(<App client={stubClient(options)} initialPath={PARENT_PATH} />);
  await screen.findByText("child", { selector: ".node-name" });
  return screen.getByRole("region", { name: "Workflow canvas" });
}

describe("#392 dangling-`workflow`-ref marker + launch badge", () => {
  it("marks the ref node and lists it in the problems panel when the target is unsaved", async () => {
    const canvas = await openParent({
      files: { [PARENT_PATH]: canonical(parentFile(true)) },
      workflows: { workflows: [summary(PARENT_PATH)] }, // child not discovered → dangling
    });

    // Per-node ⚠ on the ref chip.
    const marker = within(canvas).getByRole("img", { name: /Validation error/ });
    expect(marker).toHaveTextContent("⚠");

    // Aggregate panel row, tagged `ref`, naming the unsaved target.
    const panel = await screen.findByRole("region", { name: "Problems" });
    expect(within(panel).getByText(/has no saved file yet/)).toBeInTheDocument();
    expect(within(panel).getByText("ref")).toBeInTheDocument();
  });

  it("does not flag the ref once the target is a discovered (saved) file", async () => {
    await openParent({
      files: { [PARENT_PATH]: canonical(parentFile(true)) },
      workflows: { workflows: [summary(PARENT_PATH), summary(CHILD_PATH)] },
    });
    // Discovery lists the child, so the ref is not dangling — no panel, no marker.
    await waitFor(() => expect(screen.queryByRole("region", { name: "Problems" })).not.toBeInTheDocument());
  });

  it("badges launch with the dangling-ref count, and still lets the run launch", async () => {
    await openParent({
      files: { [PARENT_PATH]: canonical(parentFile(true)) },
      workflows: { workflows: [summary(PARENT_PATH)] },
    });

    fireEvent.click(screen.getByRole("button", { name: /Runs/ }));
    expect(await screen.findByTestId("run-launch-warning-badge")).toHaveTextContent("⚠ 1");
    // Launch is enabled (badged, not blocked) — a clean file whose ref target is merely unsaved.
    expect(screen.getByTestId("run-launch-submit")).not.toBeDisabled();
  });

  it("clears the marker when the child is saved and discovery next lists it", async () => {
    // Id-less parent opens dirty (ids stamped on import), so Save is enabled without a UI edit. The stub
    // reads `options.workflows` fresh per request, so flipping it before the save models the child's first
    // save landing on disk; the save re-fetches discovery and the ref stops being dangling.
    const options: DesignerStubOptions = {
      files: { [PARENT_PATH]: JSON.stringify(parentFile(false)) },
      workflows: { workflows: [summary(PARENT_PATH)] },
    };
    await openParent(options);
    expect(await screen.findByRole("region", { name: "Problems" })).toBeInTheDocument();

    options.workflows = { workflows: [summary(PARENT_PATH), summary(CHILD_PATH)] };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("region", { name: "Problems" })).not.toBeInTheDocument());
  });
});
