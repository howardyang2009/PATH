import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { relativeRefPath } from "../src/resolve-ref.js";
import type { OpenSession, SessionAction } from "../src/use-open-file.js";
import { useRefAuthoring } from "../src/use-ref-authoring.js";

/**
 * #391 — the nested-`workflow`-ref authoring seam, driven head-on — the in-flight node, the
 * reference-existing edit, and the create-new descent — without rendering the App and its three
 * overlays (nested-ref-authoring.test.tsx does the end-to-end path). The seam's whole job is that
 * these three transitions read side by side.
 */

const PARENT_PATH = "flows/parent.workflow.json";
const REF_NODE_ID = "11111111-1111-4111-8111-111111111111";

/** A parent file holding one empty-ref `workflow` node — the node whose target the flow chooses. */
function parentFile(): WorkflowFile {
  return {
    format: FORMAT_VERSION,
    id: "00000000-0000-4000-8000-000000000000",
    name: "parent-flow",
    body: [{ type: "workflow", id: REF_NODE_ID, name: "child", ref: "" } as WorkflowNode],
  } as WorkflowFile;
}

/** A session that records the actions the seam applies; the rest is unused here. */
function stubSession(): { session: OpenSession; applied: SessionAction[] } {
  const applied: SessionAction[] = [];
  const session = {
    apply: (action: SessionAction) => {
      applied.push(action);
    },
  } as unknown as OpenSession;
  return { session, applied };
}

describe("useRefAuthoring", () => {
  it("offers no chooser handle for a file with no path", () => {
    const { session } = stubSession();
    const { result } = renderHook(() => useRefAuthoring(session, parentFile(), undefined));
    expect(result.current.onAuthorRef).toBeUndefined();
    expect(result.current.target).toBeNull();
  });

  it("opens the chooser onto a node, carrying the parent path to exclude", () => {
    const { session } = stubSession();
    const { result } = renderHook(() => useRefAuthoring(session, parentFile(), PARENT_PATH));
    expect(result.current.target).toBeNull();
    act(() => result.current.onAuthorRef?.(REF_NODE_ID));
    expect(result.current.target).toEqual({ nodeId: REF_NODE_ID, excludePath: PARENT_PATH });
  });

  it("reference-existing writes the node's relative ref and closes", () => {
    const { session, applied } = stubSession();
    const { result } = renderHook(() => useRefAuthoring(session, parentFile(), PARENT_PATH));
    act(() => result.current.onAuthorRef?.(REF_NODE_ID));
    act(() => result.current.pickExisting("flows/other.workflow.json"));

    expect(applied).toHaveLength(1);
    const action = applied[0]!;
    if (action.type !== "applyEdit") throw new Error(`unexpected action ${action.type}`);
    const node = action.next.body[0] as WorkflowNode & { ref: string };
    expect(node.ref).toBe(relativeRefPath(PARENT_PATH, "flows/other.workflow.json"));
    expect(result.current.target).toBeNull();
  });

  it("create-new descends into a fresh child linked back to the node and closes", () => {
    const { session, applied } = stubSession();
    const { result } = renderHook(() => useRefAuthoring(session, parentFile(), PARENT_PATH));
    act(() => result.current.onAuthorRef?.(REF_NODE_ID));
    act(() => result.current.createNew());

    // Create-new sets no ref here — the child's first save back-fills it.
    expect(applied).toEqual([{ type: "descendNewUnbound", parentNodeId: REF_NODE_ID }]);
    expect(result.current.target).toBeNull();
  });

  it("cancel closes the chooser with no edit", () => {
    const { session, applied } = stubSession();
    const { result } = renderHook(() => useRefAuthoring(session, parentFile(), PARENT_PATH));
    act(() => result.current.onAuthorRef?.(REF_NODE_ID));
    act(() => result.current.cancel());
    expect(result.current.target).toBeNull();
    expect(applied).toEqual([]);
  });
});
