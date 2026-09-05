import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { relativeRefPath } from "../src/resolve-ref.js";
import type { OpenSession } from "../src/use-open-file.js";
import { useRefAuthoring } from "../src/use-ref-authoring.js";

/**
 * The nested-`workflow`-ref authoring seam (#391), driven head-on — the in-flight node, the reference-existing
 * edit, and the create-new descent — without rendering the App and its three overlays (app-391.test.tsx does
 * the end-to-end path). The seam's whole job is that these three transitions read side by side.
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

/** A session whose two transitions the seam calls; the rest is unused here. */
function stubSession(): { session: OpenSession; applyEdit: ReturnType<typeof vi.fn>; descendNewUnbound: ReturnType<typeof vi.fn> } {
  const applyEdit = vi.fn();
  const descendNewUnbound = vi.fn();
  return { session: { applyEdit, descendNewUnbound } as unknown as OpenSession, applyEdit, descendNewUnbound };
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
    const { session, applyEdit } = stubSession();
    const { result } = renderHook(() => useRefAuthoring(session, parentFile(), PARENT_PATH));
    act(() => result.current.onAuthorRef?.(REF_NODE_ID));
    act(() => result.current.pickExisting("flows/other.workflow.json"));

    expect(applyEdit).toHaveBeenCalledTimes(1);
    const edited = applyEdit.mock.calls[0]![0] as WorkflowFile;
    const node = edited.body[0] as WorkflowNode & { ref: string };
    expect(node.ref).toBe(relativeRefPath(PARENT_PATH, "flows/other.workflow.json"));
    expect(result.current.target).toBeNull();
  });

  it("create-new descends into a fresh child linked back to the node and closes", () => {
    const { session, descendNewUnbound, applyEdit } = stubSession();
    const { result } = renderHook(() => useRefAuthoring(session, parentFile(), PARENT_PATH));
    act(() => result.current.onAuthorRef?.(REF_NODE_ID));
    act(() => result.current.createNew());

    expect(descendNewUnbound).toHaveBeenCalledWith(REF_NODE_ID);
    // Create-new sets no ref here — the child's first save back-fills it.
    expect(applyEdit).not.toHaveBeenCalled();
    expect(result.current.target).toBeNull();
  });

  it("cancel closes the chooser with no edit", () => {
    const { session, applyEdit, descendNewUnbound } = stubSession();
    const { result } = renderHook(() => useRefAuthoring(session, parentFile(), PARENT_PATH));
    act(() => result.current.onAuthorRef?.(REF_NODE_ID));
    act(() => result.current.cancel());
    expect(result.current.target).toBeNull();
    expect(applyEdit).not.toHaveBeenCalled();
    expect(descendNewUnbound).not.toHaveBeenCalled();
  });
});
