import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { describe, expect, it } from "vitest";
import { canonicalSerialize } from "../src/serialize.js";
import {
  type Frame,
  frameDirty,
  initialSessionState,
  openedResultOf,
  planDelete,
  planWrite,
  reduceSession,
  type SessionOutcome,
  type SessionState,
  type TemplateSource,
} from "../src/session-reducer.js";

/** The next state of one transition. The suites that are about state read this; the fetch the
 * transition asks for has its own suite below. */
function reduce(state: SessionState, action: Parameters<typeof reduceSession>[1]): SessionState {
  return reduceSession(state, action).state;
}

/** The plan a door produces, or a failure that names the intent — so an unexpected refusal reads as
 * the intent it refused. */
function plan(state: SessionState, intent: Parameters<typeof planWrite>[1]) {
  const plan = planWrite(state, intent);
  if (!plan.ok) throw new Error(`refused ${intent.kind}: ${plan.message}`);
  return plan;
}

/**
 * The pure session state machine (`session-reducer.ts`). These tests reach every transition the
 * Designer's open-and-navigate session makes — the trail, the per-frame undo history, the
 * coalesced-edit fold, the save-point advance, the two async-result staleness guards, and the
 * create-new ref back-fill — with no React and no stub server. Before the extraction the same
 * behavior was reachable only by mounting the App (`undo.test.tsx`, `save-point.test.tsx`,
 * `new-file-first-save.test.tsx`, `nested-ref-authoring.test.tsx`, `problems-panel.test.tsx`).
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

/** An opened, written frame at `path`, whose baseline is its own canonical bytes (so it opens
 * clean). */
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
    const edited = reduce(start, { type: "applyEdit", next: file("flow", "hi") });
    expect(activeFile(edited).body[0]).toMatchObject({ prompt: "hi" });
    expect(edited.frames[0]!.history.past).toHaveLength(1);
    expect(edited.frames[0]!.history.future).toHaveLength(0);
    expect(frameDirty(edited.frames[0])).toBe(true);
  });

  it("folds a run of keystrokes under one edit identity into a single entry", () => {
    let s = sessionOn(openFrame(file("flow")));
    const prompt = { owner: "x", field: "prompt" };
    s = reduce(s, { type: "applyEdit", next: file("flow", "h"), key: prompt });
    s = reduce(s, { type: "applyEdit", next: file("flow", "hi"), key: prompt });
    // Two keystrokes, one entry — undo jumps back to where the run began, not to the intermediate.
    expect(s.frames[0]!.history.past).toHaveLength(1);
  });

  it("opens a new entry when the edit identity changes", () => {
    let s = sessionOn(openFrame(file("flow")));
    s = reduce(s, {
      type: "applyEdit",
      next: file("flow", "h"),
      key: { owner: "x", field: "prompt" },
    });
    s = reduce(s, {
      type: "applyEdit",
      next: file("flow", "hi"),
      key: { owner: "x", field: "name" },
    });
    expect(s.frames[0]!.history.past).toHaveLength(2);
  });

  it("opens a new entry for a structural edit, which carries no identity", () => {
    let s = sessionOn(openFrame(file("flow")));
    s = reduce(s, {
      type: "applyEdit",
      next: file("flow", "h"),
      key: { owner: "x", field: "prompt" },
    });
    s = reduce(s, { type: "applyEdit", next: file("flow", "hi") });
    expect(s.frames[0]!.history.past).toHaveLength(2);
  });
});

describe("session-reducer — undo / redo (#389)", () => {
  it("undo restores the past buffer and re-dirties past the save-point (ADR 0030)", () => {
    let s = sessionOn(openFrame(file("flow")));
    s = reduce(s, { type: "applyEdit", next: file("flow", "edited") });
    expect(frameDirty(s.frames[0])).toBe(true);
    s = reduce(s, { type: "undo" });
    // Back to the clean baseline buffer; the undone buffer is now redoable.
    expect(activeFile(s).body[0]).toMatchObject({ prompt: "" });
    expect(frameDirty(s.frames[0])).toBe(false);
    expect(s.frames[0]!.history.future).toHaveLength(1);
  });

  it("redo re-applies the undone buffer", () => {
    let s = sessionOn(openFrame(file("flow")));
    s = reduce(s, { type: "applyEdit", next: file("flow", "edited") });
    s = reduce(s, { type: "undo" });
    s = reduce(s, { type: "redo" });
    expect(activeFile(s).body[0]).toMatchObject({ prompt: "edited" });
    expect(s.frames[0]!.history.past).toHaveLength(1);
    expect(s.frames[0]!.history.future).toHaveLength(0);
  });

  it("undo with an empty past leaves the buffer unchanged", () => {
    const start = sessionOn(openFrame(file("flow")));
    const s = reduce(start, { type: "undo" });
    expect(activeFile(s).body[0]).toMatchObject({ prompt: "" });
    expect(s.frames[0]!.history.past).toHaveLength(0);
  });
});

describe("session-reducer — the read it asks for, and the landing it accepts", () => {
  const landedContent = {
    frameState: {
      phase: "open" as const,
      result: { status: "opened" as const, file: file("landed"), idsStamped: false },
    },
    etag: "etag-landed",
    baseline: canonicalSerialize(file("landed")),
    openedBytes: canonicalSerialize(file("landed")),
  };
  /** A frame at depth 0 awaiting fetch `token` — what the reducer puts there when a read starts. */
  const loading = (token: number, over: Partial<Frame> = {}): Frame => ({
    ...openFrame(file("flow")),
    state: { phase: "loading" },
    loadSeq: token,
    ...over,
  });
  /** The landing for whatever fetch `outcome` asked for. */
  const landing = (outcome: SessionOutcome) => ({
    type: "loadLanded" as const,
    depth: outcome.fetch!.depth,
    path: outcome.fetch!.frame.path,
    token: outcome.fetch!.token,
    ...landedContent,
  });

  it("hands out the frame to read, where it lands, and its token", () => {
    const outcome = reduceSession(initialSessionState, { type: "openLoading", path: "a.json" });

    expect(outcome.fetch).toMatchObject({ depth: 0, token: 1 });
    expect(outcome.fetch!.frame.path).toBe("a.json");
    expect(outcome.state.frames[0]!.loadSeq).toBe(1);
  });

  it("mints a fresh token per read, so a trail the author replaced cannot match", () => {
    const first = reduceSession(initialSessionState, { type: "openLoading", path: "a.json" });
    const second = reduceSession(first.state, { type: "openLoading", path: "b.json" });

    expect(second.fetch!.token).toBe(2);
    // The first read's late landing arrives at the same depth and path shape, and is dropped.
    const stale = reduceSession(second.state, {
      ...landing(second),
      token: first.fetch!.token,
      path: "a.json",
    });
    expect(stale.state).toBe(second.state);
  });

  it("asks for nothing when the action starts no read, or has nothing to read", () => {
    const open = reduceSession(initialSessionState, { type: "newFile" });
    expect(open.fetch).toBeNull();
    // A written frame reloads (asking for a read)…
    expect(
      reduceSession(sessionOn(openFrame(file("flow"))), { type: "reload" }).fetch,
    ).toMatchObject({ depth: 0, token: 1 });
    // …while a from-scratch buffer has no bytes to re-read, so it asks for nothing.
    expect(reduceSession(open.state, { type: "reload" }).fetch).toBeNull();
    // A descent that re-enters the frame just ahead reuses a live buffer.
    const root = openFrame(file("root"), { path: "root.workflow.json" });
    const child = openFrame(file("child"), { path: "flows/child.workflow.json" });
    const trail: SessionState = {
      frames: [root, child],
      activeIndex: 0,
      saveState: { phase: "idle" },
      mode: "workflow",
    };
    expect(
      reduceSession(trail, { type: "descend", ref: "flows/child.workflow.json", nodeId: "wf-1" })
        .fetch,
    ).toBeNull();
  });

  it("patches the frame when it still awaits that exact read", () => {
    const start = sessionOn(loading(7));
    const outcome = reduceSession(start, {
      type: "loadLanded",
      depth: 0,
      path: "flow.workflow.json",
      token: 7,
      ...landedContent,
    });

    expect(activeFile(outcome.state).name).toBe("landed");
    expect(outcome.state.frames[0]!.etag).toBe("etag-landed");
    // Landed: the frame is no longer waiting on anything, and the read is over.
    expect(outcome.state.frames[0]!.loadSeq).toBeNull();
    expect(outcome.fetch).toBeNull();
  });

  it("drops a result the frame no longer awaits — the author left and came back to the same path", () => {
    // Same depth, same path, but a *newer* read owns the frame. The token is the whole verdict; a
    // bare path comparison would have patched this stale result over the newer one.
    const start = sessionOn(loading(9));
    const outcome = reduceSession(start, {
      type: "loadLanded",
      depth: 0,
      path: "flow.workflow.json",
      token: 7,
      ...landedContent,
    });
    expect(outcome.state).toBe(start); // no-op — same reference
  });

  it("drops a result for a frame that already landed, or a depth the trail no longer reaches", () => {
    const done = sessionOn(openFrame(file("other")));
    expect(
      reduceSession(done, {
        type: "loadLanded",
        depth: 0,
        path: "flow.workflow.json",
        token: 7,
        ...landedContent,
      }).state,
    ).toBe(done);
    const start = sessionOn(loading(7));
    expect(
      reduceSession(start, {
        type: "loadLanded",
        depth: 5,
        path: "flow.workflow.json",
        token: 7,
        ...landedContent,
      }).state,
    ).toBe(start);
  });
});

describe("session-reducer — save-point advance (ADR 0030, ADR 0016)", () => {
  it("advances the baseline and ETag, and sets the saved phase, when the frame still matches", () => {
    let s = sessionOn(openFrame(file("flow")));
    const edited = file("flow", "edited");
    s = reduce(s, { type: "applyEdit", next: edited });
    expect(frameDirty(s.frames[0])).toBe(true);
    const savedBytes = canonicalSerialize(edited);
    s = reduce(s, {
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
    const next = reduce(s, {
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
    const s = reduce(start, {
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
    const s = reduce(start, {
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
    const s = reduce(start, {
      type: "descend",
      ref: "child.workflow.json",
      nodeId: "wf-1",
    });
    expect(s.frames).toHaveLength(2); // the stale forward frame is dropped
    expect(s.activeIndex).toBe(1);
    expect(s.frames[1]!.state.phase).toBe("loading");
    // resolved against the active frame's own directory
    expect(s.frames[1]!.path).toBe("child.workflow.json");
    // the descent remembers the workflow node it crossed
    expect(s.frames[1]!.descendedVia).toBe("wf-1");
    expect(s.frames[1]!.loadSeq).toBe(1); // and the read it awaits, stamped by the reducer
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

    const s = reduce(start, {
      type: "descend",
      ref: "flows/child.workflow.json",
      nodeId: "wf-1",
    });

    expect(s.activeIndex).toBe(1);
    // the live buffer is untouched, not reloaded out from under the author
    expect(s.frames[1]).toBe(child);
    expect(s.frames).toHaveLength(2);
  });

  it("descend is a no-op with no file open, or from a from-scratch frame with no path to resolve against", () => {
    expect(
      reduce(initialSessionState, {
        type: "descend",
        ref: "child.workflow.json",
        nodeId: "wf-1",
      }),
    ).toBe(initialSessionState);
    const scratch = reduce(initialSessionState, { type: "newFile" });
    expect(
      reduce(scratch, {
        type: "descend",
        ref: "child.workflow.json",
        nodeId: "wf-1",
      }),
    ).toBe(scratch);
  });

  it("descendNewUnbound pushes an unwritten, path-less child linked to the parent node", () => {
    const start = sessionOn(openFrame(file("root"), { path: "root.workflow.json" }));
    const s = reduce(start, { type: "descendNewUnbound", parentNodeId: uuid(9) });
    expect(s.activeIndex).toBe(1);
    const child = s.frames[1]!;
    expect(child.written).toBe(false);
    expect(child.path).toBeNull();
    expect(child.refParent).toEqual({ depth: 0, nodeId: uuid(9) });
    expect(frameDirty(child)).toBe(true); // opens dirty, so Save is live
  });

  it("goTo clamps an out-of-range index to the current active frame", () => {
    const start = sessionOn(openFrame(file("flow")));
    expect(reduce(start, { type: "goTo", index: 9 }).activeIndex).toBe(0);
    expect(reduce(start, { type: "goTo", index: -1 }).activeIndex).toBe(0);
  });
});

describe("session-reducer — reload is a decision, not a hook guard", () => {
  it("replaces a written frame with a loading one that awaits the reload's own fetch", () => {
    const start = sessionOn(openFrame(file("flow"), { descendedVia: "wf-1" }));
    const s = reduce(start, { type: "reload" });
    expect(s.frames[0]!.state.phase).toBe("loading");
    expect(s.frames[0]!.loadSeq).toBe(1); // the reducer's own token for this read
    expect(s.frames[0]!.descendedVia).toBe("wf-1"); // the descent origin survives a refetch
  });

  it("is a no-op for an unwritten buffer, so an authored buffer is never discarded for a 404", () => {
    const scratch = reduce(initialSessionState, { type: "newFile" });
    expect(reduce(scratch, { type: "reload" })).toBe(scratch);
  });
});

describe("session-reducer — the save doors (#390, #391, ADR 0016)", () => {
  it("plans an overwrite under the frame's ETag for a written file", () => {
    const written = plan(sessionOn(openFrame(file("flow"), { etag: "etag-1" })), { kind: "save" });
    expect(written.write).toMatchObject({
      to: "workflow",
      path: "flow.workflow.json",
      ifMatch: "etag-1",
    });
    expect(written.write.to === "workflow" && written.write.file.name).toBe("flow");
    // The landing action advances the frame that still holds that path.
    expect(
      written.landed({ etag: "etag-2", relativePath: "flow.workflow.json", id: uuid(1) }, "b"),
    ).toEqual({
      type: "saved",
      depth: 0,
      path: "flow.workflow.json",
      etag: "etag-2",
      savedBytes: "b",
    });
  });

  it("plans an exclusive create at the pre-assigned path for an unwritten create-new child", () => {
    const child = {
      ...openFrame(file("child"), { path: "flows/child.workflow.json" }),
      written: false,
      refParent: { depth: 0, nodeId: uuid(9) },
    };
    const created = plan(
      {
        frames: [openFrame(file("parent")), child],
        activeIndex: 1,
        saveState: { phase: "idle" },
        mode: "workflow",
      },
      { kind: "save" },
    );
    expect(created.write).toMatchObject({
      to: "workflow",
      path: "flows/child.workflow.json",
      ifMatch: undefined,
    });
    // A taken pre-assigned path is the author's to retarget, not a stale buffer to reload.
    expect(created.refused({ ok: false, conflict: "exists", message: "taken" })).toMatchObject({
      phase: "error",
    });
  });

  it("plans a workflow copy with a fresh identity, named after its new path", () => {
    const source = file("flow");
    const copy = plan(sessionOn(openFrame(source)), {
      kind: "workflow-copy",
      path: "flows/copied.workflow.json",
    });

    expect(copy.write).toMatchObject({ to: "workflow", path: "flows/copied.workflow.json" });
    // Instantiation re-stamps every id and the human name follows the new file's stem (ADR 0006).
    if (copy.write.to !== "workflow") throw new Error("expected a workflow write");
    expect(copy.write.file.id).not.toBe(source.id);
    expect(copy.write.file.name).toBe("copied");
    expect(
      copy.landed(
        { etag: "etag-c", relativePath: "flows/copied.workflow.json", id: source.id },
        "b",
      ),
    ).toMatchObject({ type: "detachedSaved", depth: 0, fromId: source.id, etag: "etag-c" });
  });

  it("plans a workflow-as-template write carrying only the body", () => {
    const source = file("flow");
    const asTemplate = plan(sessionOn(openFrame(source)), {
      kind: "workflow-as-template",
      name: "nightly",
      description: "a nightly gate",
    });

    expect(asTemplate.write).toMatchObject({ to: "new-template", name: "nightly" });
    if (asTemplate.write.to !== "new-template") throw new Error("expected a template write");
    expect(asTemplate.write.file.body).toEqual(source.body);
    expect(asTemplate.write.file.id).not.toBe(source.id);
    // The workflow stays open: the door only reports that the template landed.
    expect(asTemplate.landed({ etag: "e", relativePath: "p", id: source.id }, "b")).toEqual({
      type: "setSaveState",
      saveState: { phase: "saved-as-template", name: "nightly" },
    });
  });

  it("plans no Save for a from-scratch root, and names the dialog that owns it instead", () => {
    const scratch = reduce(initialSessionState, { type: "newFile" });
    expect(planWrite(scratch, { kind: "save" })).toMatchObject({
      ok: false,
      reason: "needs-workflow-path",
    });
    // The first-save door itself carries the path the author chose.
    expect(
      plan(scratch, { kind: "new-file", path: "flows/new.workflow.json" }).write,
    ).toMatchObject({
      to: "workflow",
      path: "flows/new.workflow.json",
      ifMatch: undefined,
    });
    // A saved frame is not a from-scratch root: it saves in place.
    expect(
      planWrite(sessionOn(openFrame(file("flow"))), { kind: "new-file", path: "x" }),
    ).toMatchObject({
      ok: false,
      reason: "needs-workflow-path",
    });
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
    const s = reduce(start, { type: "openLoading", path: "fresh.workflow.json" });
    expect(s.frames).toHaveLength(1);
    expect(s.activeIndex).toBe(0);
    expect(s.frames[0]!.state.phase).toBe("loading");
    expect(s.saveState).toEqual({ phase: "idle" });
  });

  it("newFile opens a single dirty from-scratch root", () => {
    const s = reduce(initialSessionState, { type: "newFile" });
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

  /** The session after opening the template source and its read landing, clean at the read's
   * ETag. */
  function authoring(f: WorkflowFile = file("nightly")): SessionState {
    const opened = reduceSession(initialSessionState, {
      type: "openTemplateLoading",
      template: source,
    });
    const bytes = canonicalSerialize(f);
    return reduceSession(opened.state, {
      type: "loadLanded",
      depth: opened.fetch!.depth,
      path: null,
      token: opened.fetch!.token,
      frameState: { phase: "open", result: { status: "opened", file: f, idsStamped: false } },
      etag: "etag-t",
      baseline: bytes,
      openedBytes: bytes,
    }).state;
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
    // A template buffer saves in place by id, never as a new workflow.
    expect(planWrite(s, { kind: "save" })).toMatchObject({
      ok: true,
      write: { to: "template", id: uuid(1) },
    });
  });

  it("saves back to the original template by id, under the read's If-Match", () => {
    const s = reduce(authoring(), { type: "applyEdit", next: file("nightly", "edited") });
    expect(plan(s, { kind: "save" }).write).toEqual({
      to: "template",
      id: uuid(1),
      description: source.description,
      file: file("nightly", "edited"),
      ifMatch: "etag-t",
    });
  });

  it("advances the save-point when the write-back lands on the same template", () => {
    const edited = file("nightly", "edited");
    let s = reduce(authoring(), { type: "applyEdit", next: edited });
    s = reduce(s, {
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
    const next = reduce(s, {
      type: "templateSaved",
      depth: 0,
      id: uuid(9),
      etag: "etag-x",
      savedBytes: "x",
    });
    expect(next.frames[0]!.etag).toBe("etag-t");
    expect(next.saveState).toEqual({ phase: "saved" });
  });

  it("plans a template copy from the active template buffer only, and refuses otherwise", () => {
    const copy = plan(authoring(), {
      kind: "template-copy",
      name: "copy",
      description: "",
    });
    expect(copy.write).toMatchObject({ to: "new-template", name: "copy" });
    // The copy keeps the source's body and mints a fresh template id.
    expect(copy.write.to === "new-template" && copy.write.file.id).not.toBe(uuid(1));
    expect(
      planWrite(sessionOn(openFrame(file("flow"))), {
        kind: "template-copy",
        name: "copy",
        description: "",
      }),
    ).toMatchObject({ ok: false, reason: "needs-template-name" });
  });

  it("after a Save-As the frame edits the new template, clean, with a fresh history", () => {
    const copy = { ...file("nightly", "edited"), id: uuid(7) };
    let s = reduce(authoring(), { type: "applyEdit", next: file("nightly", "edited") });
    s = reduce(s, {
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
    expect(plan(s, { kind: "save" }).write).toMatchObject({
      to: "template",
      id: uuid(7),
      ifMatch: "etag-c",
    });
  });

  it("after a workflow Save as… the session edits the new *.workflow.json, clean and written", () => {
    const source = file("flow");
    const instance = { ...file("nightly"), id: uuid(8) };
    const s = reduce(sessionOn(openFrame(source)), {
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
    const s = reduce(authoring(), { type: "reload" });
    expect(s.frames[0]).toMatchObject({
      path: null,
      template: source,
      loadSeq: 2, // the first read's token was 1
      state: { phase: "loading" },
    });
  });
});

describe("edit mode (Workflow | Template)", () => {
  it("starts in workflow mode; a switch clears the canvas in the new mode", () => {
    expect(initialSessionState.mode).toBe("workflow");
    const s = reduce(reduce(initialSessionState, { type: "newFile" }), {
      type: "switchMode",
      mode: "template",
    });
    expect(s).toMatchObject({ mode: "template", frames: [], activeIndex: 0 });
  });

  it("a new template is a from-scratch buffer in template mode, saved through the new-template door", () => {
    const s = reduce(initialSessionState, { type: "newTemplate" });
    expect(s.mode).toBe("template");
    expect(s.frames[0]).toMatchObject({ path: null, written: false });
    expect(s.frames[0]!.template).toBeUndefined();
    expect(plan(s, { kind: "new-template", name: "t", description: "" }).write).toMatchObject({
      to: "new-template",
    });
    // The same buffer offers the workflow first-save door too: identity comes from the dialog.
    expect(plan(s, { kind: "new-file", path: "x.workflow.json" }).write).toMatchObject({
      to: "workflow",
    });
    // …but a workflow-mode buffer is not a new template.
    expect(
      planWrite(reduce(initialSessionState, { type: "newFile" }), {
        kind: "new-template",
        name: "t",
        description: "",
      }),
    ).toMatchObject({ ok: false, reason: "needs-template-name" });
  });

  it("a new template's first save makes the frame edit the created template", () => {
    const s = reduce(initialSessionState, { type: "newTemplate" });
    const f = activeFile(s)!;
    const template = {
      id: f.id,
      kind: "step" as const,
      name: "gate",
      description: "a gate",
      readOnly: false,
    };
    const next = reduce(s, {
      type: "templateSavedAs",
      depth: 0,
      fromId: null,
      template,
      file: f,
      etag: "etag-n",
    });
    expect(next.frames[0]).toMatchObject({ template, written: true, etag: "etag-n" });
    // The frame now holds a template, so the new-template door is closed and Save writes it back.
    expect(planWrite(next, { kind: "new-template", name: "t", description: "" })).toMatchObject({
      ok: false,
      reason: "needs-template-name",
    });
    expect(plan(next, { kind: "save" }).write).toMatchObject({ to: "template", id: f.id });
  });

  it("opening a workflow returns to workflow mode", () => {
    const s = reduce(initialSessionState, { type: "newTemplate" });
    expect(reduce(s, { type: "openLoading", path: "a.workflow.json" }).mode).toBe("workflow");
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
    const next = reduce(start, { type: "deleted", plan });
    expect(next).toEqual({
      mode: "template",
      frames: [],
      activeIndex: 0,
      saveState: { phase: "deleted" },
    });
  });

  it("only resets the phase when the root no longer holds the deleted file", () => {
    const start = sessionOn(openFrame(file("flow"), { path: "other.workflow.json" }));
    const next = reduce(start, {
      type: "deleted",
      plan: { kind: "workflow", path: "flow.workflow.json", ifMatch: "e" },
    });
    expect(next.frames).toHaveLength(1);
    expect(next.saveState).toEqual({ phase: "idle" });
  });
});
