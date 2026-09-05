import { describe, expect, it } from "vitest";
import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { canonicalSerialize } from "../src/serialize.js";
import { frameDirty, initialSessionState, openedResultOf, reduceSession, type Frame, type SessionState } from "../src/session-reducer.js";

/**
 * The pure session state machine (`session-reducer.ts`). These tests reach every transition the Designer's
 * open-and-navigate session makes — the trail, the per-frame undo history, the coalesced-edit fold, the
 * save-point advance, the two async-result staleness guards, and the create-new ref back-fill — with no
 * React and no stub server. Before the extraction the same behavior was reachable only by mounting the App
 * (`undo.test.tsx`, `save-point.test.tsx`, `app-389…392.test.tsx`).
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

/** A one-node workflow file, its node named so an edit is visible. */
function file(name: string, prompt = ""): WorkflowFile {
  return { format: FORMAT_VERSION, id: uuid(1), name, body: [{ type: "prompt", id: uuid(2), name: "step", prompt } as WorkflowNode] };
}

/** An opened, written frame at `path`, whose baseline is its own canonical bytes (so it opens clean). */
function openFrame(f: WorkflowFile, overrides: Partial<Frame> = {}): Frame {
  const bytes = canonicalSerialize(f);
  return {
    path: "flow.workflow.json",
    written: true,
    state: { phase: "open", result: { status: "opened", file: f, idsStamped: false } },
    etag: "etag-open",
    baseline: bytes,
    openedBytes: bytes,
    history: { past: [], future: [], coalesceKey: undefined },
    ...overrides,
  };
}

/** A single-frame session on `frame`, active. */
function sessionOn(frame: Frame): SessionState {
  return { frames: [frame], activeIndex: 0, saveState: { phase: "idle" } };
}

/** The active frame's opened file (asserted present). */
function activeFile(state: SessionState): WorkflowFile {
  const opened = openedResultOf(state.frames[state.activeIndex]);
  if (!opened) throw new Error("active frame is not open");
  return opened.file;
}

describe("session-reducer — applyEdit and the undo history (#389)", () => {
  it("records an undo entry, clears redo, and re-derives dirty", () => {
    const start = sessionOn(openFrame(file("flow")));
    const edited = reduceSession(start, { type: "applyEdit", next: file("flow", "hi") });
    expect(activeFile(edited).body[0]).toMatchObject({ prompt: "hi" });
    expect(edited.frames[0]!.history.past).toHaveLength(1);
    expect(edited.frames[0]!.history.future).toHaveLength(0);
    expect(frameDirty(edited.frames[0])).toBe(true);
  });

  it("folds a run of keystrokes under one coalesce key into a single entry", () => {
    let s = sessionOn(openFrame(file("flow")));
    s = reduceSession(s, { type: "applyEdit", next: file("flow", "h"), coalesce: "prompt:x" });
    s = reduceSession(s, { type: "applyEdit", next: file("flow", "hi"), coalesce: "prompt:x" });
    // Two keystrokes, one entry — undo jumps back to where the run began, not to the intermediate.
    expect(s.frames[0]!.history.past).toHaveLength(1);
  });

  it("opens a new entry when the coalesce key changes", () => {
    let s = sessionOn(openFrame(file("flow")));
    s = reduceSession(s, { type: "applyEdit", next: file("flow", "h"), coalesce: "prompt:x" });
    s = reduceSession(s, { type: "applyEdit", next: file("flow", "hi"), coalesce: "name:x" });
    expect(s.frames[0]!.history.past).toHaveLength(2);
  });
});

describe("session-reducer — undo / redo (#389)", () => {
  it("undo restores the past buffer and re-dirties past the save-point (ADR 0030)", () => {
    let s = sessionOn(openFrame(file("flow")));
    s = reduceSession(s, { type: "applyEdit", next: file("flow", "edited") });
    expect(frameDirty(s.frames[0])).toBe(true);
    s = reduceSession(s, { type: "undo" });
    // Back to the clean baseline buffer; the undone buffer is now redoable.
    expect(activeFile(s).body[0]).toMatchObject({ prompt: "" });
    expect(frameDirty(s.frames[0])).toBe(false);
    expect(s.frames[0]!.history.future).toHaveLength(1);
  });

  it("redo re-applies the undone buffer", () => {
    let s = sessionOn(openFrame(file("flow")));
    s = reduceSession(s, { type: "applyEdit", next: file("flow", "edited") });
    s = reduceSession(s, { type: "undo" });
    s = reduceSession(s, { type: "redo" });
    expect(activeFile(s).body[0]).toMatchObject({ prompt: "edited" });
    expect(s.frames[0]!.history.past).toHaveLength(1);
    expect(s.frames[0]!.history.future).toHaveLength(0);
  });

  it("undo with an empty past leaves the buffer unchanged", () => {
    const start = sessionOn(openFrame(file("flow")));
    const s = reduceSession(start, { type: "undo" });
    expect(activeFile(s).body[0]).toMatchObject({ prompt: "" });
    expect(s.frames[0]!.history.past).toHaveLength(0);
  });
});

describe("session-reducer — loadLanded staleness guard", () => {
  const landed = {
    type: "loadLanded" as const,
    depth: 0,
    path: "flow.workflow.json",
    frameState: { phase: "open" as const, result: { status: "opened" as const, file: file("landed"), idsStamped: false } },
    etag: "etag-landed",
    baseline: canonicalSerialize(file("landed")),
    openedBytes: canonicalSerialize(file("landed")),
  };

  it("patches the frame when it still holds the target path", () => {
    const start: SessionState = { frames: [{ ...openFrame(file("flow")), state: { phase: "loading" } }], activeIndex: 0, saveState: { phase: "idle" } };
    const s = reduceSession(start, landed);
    expect(activeFile(s).name).toBe("landed");
    expect(s.frames[0]!.etag).toBe("etag-landed");
    expect(s.frames[0]!.history.past).toHaveLength(0);
  });

  it("drops a result whose frame the author already left (path mismatch)", () => {
    // The author descended, so depth 0 now holds a different file than the in-flight load was for.
    const start = sessionOn(openFrame(file("other"), { path: "other.workflow.json" }));
    const s = reduceSession(start, landed);
    expect(s).toBe(start); // no-op — same reference
  });

  it("drops a result for a depth the trail no longer reaches", () => {
    const start = sessionOn(openFrame(file("flow")));
    const s = reduceSession(start, { ...landed, depth: 5 });
    expect(s).toBe(start);
  });
});

describe("session-reducer — save-point advance (ADR 0030, ADR 0016)", () => {
  it("advances the baseline and ETag, and sets the saved phase, when the frame still matches", () => {
    let s = sessionOn(openFrame(file("flow")));
    const edited = file("flow", "edited");
    s = reduceSession(s, { type: "applyEdit", next: edited });
    expect(frameDirty(s.frames[0])).toBe(true);
    const savedBytes = canonicalSerialize(edited);
    s = reduceSession(s, { type: "saved", depth: 0, path: "flow.workflow.json", etag: "etag-2", savedBytes });
    expect(s.saveState).toEqual({ phase: "saved" });
    expect(s.frames[0]!.etag).toBe("etag-2");
    expect(s.frames[0]!.baseline).toBe(savedBytes);
    expect(frameDirty(s.frames[0])).toBe(false); // clean at the new save-point
  });

  it("sets the saved phase but does not re-base a frame the author navigated off (path mismatch)", () => {
    const s = sessionOn(openFrame(file("flow"), { etag: "etag-open" }));
    const next = reduceSession(s, { type: "saved", depth: 0, path: "gone.workflow.json", etag: "etag-2", savedBytes: "x" });
    expect(next.saveState).toEqual({ phase: "saved" });
    expect(next.frames[0]!.etag).toBe("etag-open"); // unchanged
  });
});

describe("session-reducer — newFileSaved back-fill (#390, #391)", () => {
  it("adopts the server path, flips written, clears refParent, and back-fills the parent ref", () => {
    const parent = file("parent");
    const parentWithRef: WorkflowFile = {
      ...parent,
      body: [{ type: "workflow", id: uuid(9), name: "child-ref", ref: "" } as WorkflowNode],
    };
    const parentFrame = openFrame(parentWithRef, { path: "flows/parent.workflow.json" });
    const child = file("child");
    const childFrame: Frame = {
      ...openFrame(child, { path: null, written: false, etag: null, baseline: "" }),
      refParent: { depth: 0, nodeId: uuid(9) },
    };
    const start: SessionState = { frames: [parentFrame, childFrame], activeIndex: 1, saveState: { phase: "saving" } };

    const savedBytes = canonicalSerialize(child);
    const s = reduceSession(start, {
      type: "newFileSaved",
      depth: 1,
      etag: "etag-child",
      savedBytes,
      relativePath: "flows/child.workflow.json",
    });

    const boundChild = s.frames[1]!;
    expect(boundChild.path).toBe("flows/child.workflow.json");
    expect(boundChild.written).toBe(true);
    expect(boundChild.refParent).toBeUndefined();

    const parentNode = openedResultOf(s.frames[0])!.file.body[0] as WorkflowNode & { ref: string };
    expect(parentNode.ref).toBe("child.workflow.json"); // relativeRefPath from the saved path
    expect(frameDirty(s.frames[0])).toBe(true); // the ref back-fill dirties the parent
    expect(s.saveState).toEqual({ phase: "saved" });
  });

  it("refuses to re-base a frame that is already written", () => {
    const start = sessionOn(openFrame(file("flow"))); // written: true
    const s = reduceSession(start, { type: "newFileSaved", depth: 0, etag: "e", savedBytes: "x", relativePath: "p.workflow.json" });
    expect(s.frames[0]!.path).toBe("flow.workflow.json"); // unchanged
    expect(s.saveState).toEqual({ phase: "saved" });
  });
});

describe("session-reducer — the navigation trail (#367, #391)", () => {
  it("descendLoading truncates the forward trail and pushes a loading child", () => {
    const root = openFrame(file("root"), { path: "root.workflow.json" });
    const stale = openFrame(file("stale"), { path: "stale.workflow.json" });
    const start: SessionState = { frames: [root, stale], activeIndex: 0, saveState: { phase: "idle" } };
    const s = reduceSession(start, { type: "descendLoading", path: "child.workflow.json" });
    expect(s.frames).toHaveLength(2); // the stale forward frame is dropped
    expect(s.activeIndex).toBe(1);
    expect(s.frames[1]!.state.phase).toBe("loading");
    expect(s.frames[1]!.path).toBe("child.workflow.json");
  });

  it("descendReuse only moves the active index forward", () => {
    const root = openFrame(file("root"), { path: "root.workflow.json" });
    const child = openFrame(file("child"), { path: "child.workflow.json" });
    const start: SessionState = { frames: [root, child], activeIndex: 0, saveState: { phase: "idle" } };
    const s = reduceSession(start, { type: "descendReuse" });
    expect(s.activeIndex).toBe(1);
    expect(s.frames[1]).toBe(child); // the live buffer is untouched
  });

  it("descendNewUnbound pushes an unwritten, path-less child linked to the parent node", () => {
    const start = sessionOn(openFrame(file("root"), { path: "root.workflow.json" }));
    const s = reduceSession(start, { type: "descendNewUnbound", parentNodeId: uuid(9) });
    expect(s.activeIndex).toBe(1);
    const child = s.frames[1]!;
    expect(child.written).toBe(false);
    expect(child.path).toBeNull();
    expect(child.refParent).toEqual({ depth: 0, nodeId: uuid(9) });
    expect(frameDirty(child)).toBe(true); // opens dirty, so Save is live
  });

  it("goTo clamps an out-of-range index to the current active frame", () => {
    const start = sessionOn(openFrame(file("flow")));
    expect(reduceSession(start, { type: "goTo", index: 9 }).activeIndex).toBe(0);
    expect(reduceSession(start, { type: "goTo", index: -1 }).activeIndex).toBe(0);
  });
});

describe("session-reducer — fresh opens reset the stack", () => {
  it("openLoading discards the current trail for one loading root", () => {
    const start: SessionState = { frames: [openFrame(file("a")), openFrame(file("b"))], activeIndex: 1, saveState: { phase: "saved" } };
    const s = reduceSession(start, { type: "openLoading", path: "fresh.workflow.json" });
    expect(s.frames).toHaveLength(1);
    expect(s.activeIndex).toBe(0);
    expect(s.frames[0]!.state.phase).toBe("loading");
    expect(s.saveState).toEqual({ phase: "idle" });
  });

  it("newFile opens a single dirty from-scratch root", () => {
    const s = reduceSession(initialSessionState, { type: "newFile" });
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]!.written).toBe(false);
    expect(s.frames[0]!.path).toBeNull();
    expect(frameDirty(s.frames[0])).toBe(true);
  });
});
