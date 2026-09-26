import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { describe, expect, it } from "vitest";
import { canonicalSerialize } from "../src/serialize.js";
import {
  type Frame,
  frameDirty,
  initialSessionState,
  openedResultOf,
  planDelete,
  planNewFileSave,
  planNewTemplateSave,
  planSave,
  planTemplateSaveAs,
  reduceSession,
  type SessionState,
  type TemplateSource,
} from "../src/session-reducer.js";

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
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name,
    body: [{ type: "prompt", id: uuid(2), name: "step", prompt } as WorkflowNode],
  };
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
    loadSeq: null,
    ...overrides,
  };
}

/** A single-frame session on `frame`, active. */
function sessionOn(frame: Frame): SessionState {
  return { frames: [frame], activeIndex: 0, saveState: { phase: "idle" }, mode: "workflow" };
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

  it("folds a run of keystrokes under one edit identity into a single entry", () => {
    let s = sessionOn(openFrame(file("flow")));
    const prompt = { owner: "x", field: "prompt" };
    s = reduceSession(s, { type: "applyEdit", next: file("flow", "h"), key: prompt });
    s = reduceSession(s, { type: "applyEdit", next: file("flow", "hi"), key: prompt });
    // Two keystrokes, one entry — undo jumps back to where the run began, not to the intermediate.
    expect(s.frames[0]!.history.past).toHaveLength(1);
  });

  it("opens a new entry when the edit identity changes", () => {
    let s = sessionOn(openFrame(file("flow")));
    s = reduceSession(s, {
      type: "applyEdit",
      next: file("flow", "h"),
      key: { owner: "x", field: "prompt" },
    });
    s = reduceSession(s, {
      type: "applyEdit",
      next: file("flow", "hi"),
      key: { owner: "x", field: "name" },
    });
    expect(s.frames[0]!.history.past).toHaveLength(2);
  });

  it("opens a new entry for a structural edit, which carries no identity", () => {
    let s = sessionOn(openFrame(file("flow")));
    s = reduceSession(s, {
      type: "applyEdit",
      next: file("flow", "h"),
      key: { owner: "x", field: "prompt" },
    });
    s = reduceSession(s, { type: "applyEdit", next: file("flow", "hi") });
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
    loadSeq: 7,
    frameState: {
      phase: "open" as const,
      result: { status: "opened" as const, file: file("landed"), idsStamped: false },
    },
    etag: "etag-landed",
    baseline: canonicalSerialize(file("landed")),
    openedBytes: canonicalSerialize(file("landed")),
  };
  /** A frame at depth 0 awaiting fetch `seq` — what the reducer puts there when the hook starts one. */
  const loading = (seq: number, over: Partial<Frame> = {}): Frame => ({
    ...openFrame(file("flow")),
    state: { phase: "loading" },
    loadSeq: seq,
    ...over,
  });

  it("patches the frame when it still awaits that exact fetch", () => {
    const s = reduceSession(sessionOn(loading(7)), landed);
    expect(activeFile(s).name).toBe("landed");
    expect(s.frames[0]!.etag).toBe("etag-landed");
    expect(s.frames[0]!.loadSeq).toBeNull(); // landed: the frame is no longer waiting on anything
    expect(s.frames[0]!.history.past).toHaveLength(0);
  });

  it("drops a result the frame no longer awaits — the author left and came back to the same path", () => {
    // Same depth, same path, but a *newer* fetch owns the frame. The seq is the whole verdict; a bare
    // path comparison would have patched this stale result over the newer one.
    const start = sessionOn(loading(9));
    expect(reduceSession(start, landed)).toBe(start); // no-op — same reference
  });

  it("drops a result for a frame that already landed (no fetch awaited)", () => {
    const start = sessionOn(openFrame(file("other")));
    expect(reduceSession(start, landed)).toBe(start);
  });

  it("drops a result for a depth the trail no longer reaches", () => {
    const start = sessionOn(loading(7));
    expect(reduceSession(start, { ...landed, depth: 5 })).toBe(start);
  });
});

describe("session-reducer — save-point advance (ADR 0030, ADR 0016)", () => {
  it("advances the baseline and ETag, and sets the saved phase, when the frame still matches", () => {
    let s = sessionOn(openFrame(file("flow")));
    const edited = file("flow", "edited");
    s = reduceSession(s, { type: "applyEdit", next: edited });
    expect(frameDirty(s.frames[0])).toBe(true);
    const savedBytes = canonicalSerialize(edited);
    s = reduceSession(s, {
      type: "saved",
      depth: 0,
      path: "flow.workflow.json",
      etag: "etag-2",
      savedBytes,
    });
    expect(s.saveState).toEqual({ phase: "saved" });
    expect(s.frames[0]!.etag).toBe("etag-2");
    expect(s.frames[0]!.baseline).toBe(savedBytes);
    expect(frameDirty(s.frames[0])).toBe(false); // clean at the new save-point
  });

  it("sets the saved phase but does not re-base a frame the author navigated off (path mismatch)", () => {
    const s = sessionOn(openFrame(file("flow"), { etag: "etag-open" }));
    const next = reduceSession(s, {
      type: "saved",
      depth: 0,
      path: "gone.workflow.json",
      etag: "etag-2",
      savedBytes: "x",
    });
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
    const start: SessionState = {
      frames: [parentFrame, childFrame],
      activeIndex: 1,
      saveState: { phase: "saving" },
      mode: "workflow",
    };

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
    const s = reduceSession(start, {
      type: "newFileSaved",
      depth: 0,
      etag: "e",
      savedBytes: "x",
      relativePath: "p.workflow.json",
    });
    expect(s.frames[0]!.path).toBe("flow.workflow.json"); // unchanged
    expect(s.saveState).toEqual({ phase: "saved" });
  });
});

describe("session-reducer — the navigation trail (#367, #391)", () => {
  it("descend truncates the forward trail and pushes a loading child", () => {
    const root = openFrame(file("root"), { path: "root.workflow.json" });
    const stale = openFrame(file("stale"), { path: "stale.workflow.json" });
    const start: SessionState = {
      frames: [root, stale],
      activeIndex: 0,
      saveState: { phase: "idle" },
      mode: "workflow",
    };
    const s = reduceSession(start, {
      type: "descend",
      ref: "child.workflow.json",
      nodeId: "wf-1",
      loadSeq: 3,
    });
    expect(s.frames).toHaveLength(2); // the stale forward frame is dropped
    expect(s.activeIndex).toBe(1);
    expect(s.frames[1]!.state.phase).toBe("loading");
    expect(s.frames[1]!.path).toBe("child.workflow.json"); // resolved against the active frame's own directory
    expect(s.frames[1]!.descendedVia).toBe("wf-1"); // the descent remembers the workflow node it crossed
    expect(s.frames[1]!.loadSeq).toBe(3); // and the fetch it awaits
  });

  it("descend re-enters the frame just ahead when it already holds the resolved target", () => {
    const root = openFrame(file("root"), { path: "root.workflow.json" });
    const child = openFrame(file("child"), { path: "flows/child.workflow.json" });
    const start: SessionState = {
      frames: [root, child],
      activeIndex: 0,
      saveState: { phase: "idle" },
      mode: "workflow",
    };

    const s = reduceSession(start, {
      type: "descend",
      ref: "flows/child.workflow.json",
      nodeId: "wf-1",
      loadSeq: 3,
    });

    expect(s.activeIndex).toBe(1);
    expect(s.frames[1]).toBe(child); // the live buffer is untouched, not reloaded out from under the author
    expect(s.frames).toHaveLength(2);
  });

  it("descend is a no-op with no file open, or from a from-scratch frame with no path to resolve against", () => {
    expect(
      reduceSession(initialSessionState, {
        type: "descend",
        ref: "child.workflow.json",
        nodeId: "wf-1",
        loadSeq: 3,
      }),
    ).toBe(initialSessionState);
    const scratch = reduceSession(initialSessionState, { type: "newFile" });
    expect(
      reduceSession(scratch, {
        type: "descend",
        ref: "child.workflow.json",
        nodeId: "wf-1",
        loadSeq: 3,
      }),
    ).toBe(scratch);
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

describe("session-reducer — reload is a decision, not a hook guard", () => {
  it("replaces a written frame with a loading one that awaits the reload's own fetch", () => {
    const start = sessionOn(openFrame(file("flow"), { descendedVia: "wf-1" }));
    const s = reduceSession(start, { type: "reload", loadSeq: 4 });
    expect(s.frames[0]!.state.phase).toBe("loading");
    expect(s.frames[0]!.loadSeq).toBe(4);
    expect(s.frames[0]!.descendedVia).toBe("wf-1"); // the descent origin survives a refetch
  });

  it("is a no-op for an unwritten buffer, so an authored buffer is never discarded for a 404", () => {
    const scratch = reduceSession(initialSessionState, { type: "newFile" });
    expect(reduceSession(scratch, { type: "reload", loadSeq: 4 })).toBe(scratch);
  });
});

describe("session-reducer — the save doors (#390, #391, ADR 0016)", () => {
  it("plans an overwrite under the frame's ETag for a written file", () => {
    const plan = planSave(sessionOn(openFrame(file("flow"), { etag: "etag-1" })));
    expect(plan).toMatchObject({
      kind: "overwrite",
      depth: 0,
      path: "flow.workflow.json",
      ifMatch: "etag-1",
    });
    expect(plan && plan.kind === "overwrite" && plan.file.name).toBe("flow");
  });

  it("plans an exclusive create at the pre-assigned path for an unwritten create-new child", () => {
    const child = {
      ...openFrame(file("child"), { path: "flows/child.workflow.json" }),
      written: false,
      refParent: { depth: 0, nodeId: uuid(9) },
    };
    const plan = planSave({
      frames: [openFrame(file("parent")), child],
      activeIndex: 1,
      saveState: { phase: "idle" },
      mode: "workflow",
    });
    expect(plan).toMatchObject({
      kind: "create",
      depth: 1,
      path: "flows/child.workflow.json",
      ifMatch: undefined,
    });
  });

  it("plans nothing for a from-scratch root, which the first-save dialog owns instead", () => {
    const scratch = reduceSession(initialSessionState, { type: "newFile" });
    expect(planSave(scratch)).toBeNull();
    expect(planNewFileSave(scratch)).toMatchObject({ depth: 0 });
    expect(planNewFileSave(sessionOn(openFrame(file("flow"))))).toBeNull();
  });
});

describe("session-reducer — fresh opens reset the stack", () => {
  it("openLoading discards the current trail for one loading root", () => {
    const start: SessionState = {
      frames: [openFrame(file("a")), openFrame(file("b"))],
      activeIndex: 1,
      saveState: { phase: "saved" },
      mode: "workflow",
    };
    const s = reduceSession(start, {
      type: "openLoading",
      path: "fresh.workflow.json",
      loadSeq: 1,
    });
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

describe("session-reducer — author mode on a *.step-template.json (#580)", () => {
  const source: TemplateSource = {
    id: uuid(1),
    kind: "step",
    name: "nightly",
    description: "",
    readOnly: false,
  };

  /** The session after opening the template source and its read landing, clean at the read's ETag. */
  function authoring(f: WorkflowFile = file("nightly")): SessionState {
    const loading = reduceSession(initialSessionState, {
      type: "openTemplateLoading",
      template: source,
      loadSeq: 3,
    });
    const bytes = canonicalSerialize(f);
    return reduceSession(loading, {
      type: "loadLanded",
      depth: 0,
      path: null,
      loadSeq: 3,
      frameState: { phase: "open", result: { status: "opened", file: f, idsStamped: false } },
      etag: "etag-t",
      baseline: bytes,
      openedBytes: bytes,
    });
  }

  it("opens the template source as a written, path-less frame that remembers its template", () => {
    const s = authoring();
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]).toMatchObject({
      path: null,
      written: true,
      template: source,
      etag: "etag-t",
    });
    expect(frameDirty(s.frames[0])).toBe(false);
    expect(planNewFileSave(s)).toBeNull();
  });

  it("saves back to the original template by id, under the read's If-Match", () => {
    const s = reduceSession(authoring(), { type: "applyEdit", next: file("nightly", "edited") });
    expect(planSave(s)).toEqual({
      kind: "template",
      depth: 0,
      id: uuid(1),
      template: source,
      file: file("nightly", "edited"),
      ifMatch: "etag-t",
    });
  });

  it("advances the save-point when the write-back lands on the same template", () => {
    const edited = file("nightly", "edited");
    let s = reduceSession(authoring(), { type: "applyEdit", next: edited });
    s = reduceSession(s, {
      type: "templateSaved",
      depth: 0,
      id: uuid(1),
      etag: "etag-t2",
      savedBytes: canonicalSerialize(edited),
    });
    expect(s.saveState).toEqual({ phase: "saved" });
    expect(s.frames[0]!.etag).toBe("etag-t2");
    expect(frameDirty(s.frames[0])).toBe(false);
  });

  it("does not re-base a frame that no longer holds the saved template", () => {
    const s = authoring();
    const next = reduceSession(s, {
      type: "templateSaved",
      depth: 0,
      id: uuid(9),
      etag: "etag-x",
      savedBytes: "x",
    });
    expect(next.frames[0]!.etag).toBe("etag-t");
    expect(next.saveState).toEqual({ phase: "saved" });
  });

  it("plans a save-as from the active template buffer only", () => {
    expect(planTemplateSaveAs(authoring())).toEqual({
      depth: 0,
      template: source,
      file: file("nightly"),
    });
    expect(planTemplateSaveAs(sessionOn(openFrame(file("flow"))))).toBeNull();
  });

  it("after a Save-As the frame edits the new template, clean, with a fresh history", () => {
    const copy = { ...file("nightly", "edited"), id: uuid(7) };
    let s = reduceSession(authoring(), { type: "applyEdit", next: file("nightly", "edited") });
    s = reduceSession(s, {
      type: "templateSavedAs",
      depth: 0,
      fromId: uuid(1),
      template: { id: uuid(7), kind: "step", name: "copy", description: "", readOnly: false },
      file: copy,
      etag: "etag-c",
    });
    expect(s.frames[0]).toMatchObject({
      template: { id: uuid(7), kind: "step", name: "copy", readOnly: false },
      etag: "etag-c",
    });
    expect(activeFile(s)).toEqual(copy);
    expect(frameDirty(s.frames[0])).toBe(false);
    expect(s.frames[0]!.history.past).toHaveLength(0);
    expect(planSave(s)).toMatchObject({ kind: "template", id: uuid(7), ifMatch: "etag-c" });
  });

  it("after a workflow Save as… the session edits the new *.workflow.json, clean and written", () => {
    const source = file("flow");
    const instance = { ...file("nightly"), id: uuid(8) };
    const s = reduceSession(sessionOn(openFrame(source)), {
      type: "detachedSaved",
      depth: 0,
      fromId: source.id,
      file: instance,
      relativePath: "nightly.workflow.json",
      etag: "etag-w",
    });
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]).toMatchObject({
      path: "nightly.workflow.json",
      written: true,
      etag: "etag-w",
    });
    expect(s.frames[0]!.template).toBeUndefined();
    expect(activeFile(s)).toEqual(instance);
    expect(frameDirty(s.frames[0])).toBe(false);
    expect(s.saveState).toEqual({ phase: "saved" });
  });

  it("reload re-reads the template source, keeping it a template frame", () => {
    const s = reduceSession(authoring(), { type: "reload", loadSeq: 4 });
    expect(s.frames[0]).toMatchObject({
      path: null,
      template: source,
      loadSeq: 4,
      state: { phase: "loading" },
    });
  });
});

describe("edit mode (Workflow | Template)", () => {
  it("starts in workflow mode; a switch clears the canvas in the new mode", () => {
    expect(initialSessionState.mode).toBe("workflow");
    const s = reduceSession(reduceSession(initialSessionState, { type: "newFile" }), {
      type: "switchMode",
      mode: "template",
    });
    expect(s).toMatchObject({ mode: "template", frames: [], activeIndex: 0 });
  });

  it("a new template is a from-scratch buffer in template mode, saved through the new-template door", () => {
    const s = reduceSession(initialSessionState, { type: "newTemplate" });
    expect(s.mode).toBe("template");
    expect(s.frames[0]).toMatchObject({ path: null, written: false });
    expect(s.frames[0]!.template).toBeUndefined();
    expect(planNewTemplateSave(s)).toMatchObject({ depth: 0 });
    expect(planNewFileSave(s)).toMatchObject({ depth: 0 });
    // The same buffer in workflow mode is a new workflow, not a new template.
    expect(planNewTemplateSave(reduceSession(initialSessionState, { type: "newFile" }))).toBeNull();
  });

  it("a new template's first save makes the frame edit the created template", () => {
    const s = reduceSession(initialSessionState, { type: "newTemplate" });
    const f = activeFile(s)!;
    const template = {
      id: f.id,
      kind: "step" as const,
      name: "gate",
      description: "a gate",
      readOnly: false,
    };
    const next = reduceSession(s, {
      type: "templateSavedAs",
      depth: 0,
      fromId: null,
      template,
      file: f,
      etag: "etag-n",
    });
    expect(next.frames[0]).toMatchObject({ template, written: true, etag: "etag-n" });
    expect(planNewTemplateSave(next)).toBeNull();
  });

  it("opening a workflow returns to workflow mode", () => {
    const s = reduceSession(initialSessionState, { type: "newTemplate" });
    expect(
      reduceSession(s, { type: "openLoading", path: "a.workflow.json", loadSeq: 1 }).mode,
    ).toBe("workflow");
  });
});

describe("planDelete and the deleted action", () => {
  const template: TemplateSource = {
    id: uuid(90),
    kind: "step",
    name: "nightly",
    description: "",
    readOnly: false,
  };

  it("plans a written root workflow under its read ETag", () => {
    expect(planDelete(sessionOn(openFrame(file("flow"))))).toEqual({
      kind: "workflow",
      path: "flow.workflow.json",
      ifMatch: "etag-open",
    });
  });

  it("plans a user template by id, but not a shipped one", () => {
    expect(planDelete(sessionOn(openFrame(file("flow"), { path: null, template })))).toEqual({
      kind: "template",
      id: uuid(90),
      name: "nightly",
    });
    expect(
      planDelete(
        sessionOn(
          openFrame(file("flow"), { path: null, template: { ...template, readOnly: true } }),
        ),
      ),
    ).toBeNull();
  });

  it("plans nothing for a never-saved buffer or a nested active frame", () => {
    expect(
      planDelete(sessionOn(openFrame(file("flow"), { path: null, written: false }))),
    ).toBeNull();
    const nested: SessionState = {
      ...sessionOn(openFrame(file("flow"))),
      frames: [openFrame(file("flow")), openFrame(file("child"))],
      activeIndex: 1,
    };
    expect(planDelete(nested)).toBeNull();
  });

  it("empties the canvas in the same mode when the deleted file is still the root", () => {
    const start = { ...sessionOn(openFrame(file("flow"))), mode: "template" as const };
    const plan = planDelete(sessionOn(openFrame(file("flow"))))!;
    const next = reduceSession(start, { type: "deleted", plan });
    expect(next).toEqual({
      mode: "template",
      frames: [],
      activeIndex: 0,
      saveState: { phase: "deleted" },
    });
  });

  it("only resets the phase when the root no longer holds the deleted file", () => {
    const start = sessionOn(openFrame(file("flow"), { path: "other.workflow.json" }));
    const next = reduceSession(start, {
      type: "deleted",
      plan: { kind: "workflow", path: "flow.workflow.json", ifMatch: "e" },
    });
    expect(next.frames).toHaveLength(1);
    expect(next.saveState).toEqual({ phase: "idle" });
  });
});
