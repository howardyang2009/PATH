import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import type { EditKey } from "./edit-key.js";
import { sameEditKey } from "./edit-key.js";
import { editFile, findById, unwrapEdit } from "./edit-tree.js";
import type { OpenResult } from "./open-workflow.js";
import { basename, relativeRefPath, resolveRefPath } from "./resolve-ref.js";
import { canonicalSerialize } from "./serialize.js";

/**
 * The Designer session's **pure state machine**: every open/descend/edit/undo/save-point transition is a
 * case of `reduceSession`, a pure `(state, action) => state`. The `useOpenFile` hook runs the async I/O and
 * dispatches the results, so no promise, no `client` and no wall-clock timing lives here.
 */

// ── Frame types ────────────────────────────────────────────────────────────────────────────────────

/** One file on the navigation stack: its path, where its fetch-and-open got to, and its save-point. */
export interface Frame {
  /** Project-relative path, or **`null`** for a from-scratch buffer until its first save. */
  path: string | null;
  /**
   * Has this buffer been **persisted to disk**? An unwritten frame takes no lease and cannot launch, and its first
   * save is an exclusive create (no `If-Match`, ADR 0016).
   */
  written: boolean;
  state: FrameState;
  /** The `If-Match` ETag for the next save; `null` when a proxy stripped the read route's `ETag` header. */
  etag: string | null;
  /**
   * The on-disk bytes last synced (ADR 0030): the buffer is **clean** when `canonicalSerialize(buffer) === baseline`.
   * Advances only on a `200` save.
   */
  baseline: string;
  /** `canonicalSerialize(buffer)` at the last save-point; steers only the badge's wording, not dirtiness. */
  openedBytes: string;
  /** This frame's own undo/redo stack; independent per open file and survives this frame's saves. */
  history: History;
  /**
   * A create-new nested-ref child's back-link to the `workflow` node that spawned it; consumed at the child's first
   * save to back-fill the parent's `ref`.
   */
  refParent?: { depth: number; nodeId: string };
  /**
   * The parent frame's `workflow` block whose ref this frame descended through, so the breadcrumb badges this crumb
   * with the sub-workflow's run status.
   */
  descendedVia?: string;
  /**
   * The fetch this frame awaits, or `null` when idle. `loadLanded` patches in only while the number still matches,
   * which is the whole staleness verdict.
   */
  loadSeq: number | null;
  /**
   * The template this frame edits in author mode; a template frame is `written` but path-less, so it takes no lease
   * and saves by id (ADR 0050).
   */
  template?: TemplateSource;
}

/** The file suffix a template carries on disk: `*.step-template.json`, one kind only (ADR 0063). */
export const TEMPLATE_SUFFIX = ".step-template.json";

/** The template an author-mode frame edits: its id (the route key), kind, file stem, and origin. */
export interface TemplateSource {
  id: string;
  /** Always `step` (ADR 0063); only `body` goes back into the envelope on save. */
  kind: "step";
  name: string;
  description: string;
  /** A shipped template: the write-back `PUT` answers `403`, so only the two Save-As doors work. */
  readOnly: boolean;
}

/** A frame is fetching, failed to fetch, or has an open outcome (which may itself be a legible refusal). */
export type FrameState =
  | { phase: "loading" }
  | { phase: "fetch-error"; message: string }
  | { phase: "open"; result: OpenResult };

/** The undo/redo history of one frame: snapshots either side of the present buffer, which is not held here.
 * Per-frame, and survives a save, so undoing past the save-point re-dirties. Any new edit clears redo. */
export interface History {
  past: WorkflowFile[];
  future: WorkflowFile[];
  /** Identity of the in-progress field-edit run; a matching field edit folds into the current entry. */
  coalesceKey: EditKey | undefined;
}

/** The active frame's save phase (ADR 0016), a transient UI phase rather than the dirty relation. A Delete
 * rides the same phase; `saved-as-template` confirms a workflow-mode Save as template. */
export type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved" }
  | { phase: "conflict"; message: string }
  | { phase: "error"; message: string }
  | { phase: "deleting" }
  | { phase: "deleted" }
  | { phase: "delete-error"; message: string }
  | { phase: "saved-as-template"; name: string };

/** A frame's opened workflow result, or `null` when it is loading, failed to fetch, or is a refusal. */
export type OpenedResult = Extract<OpenResult, { status: "opened" }>;

// ── Frame helpers (pure) ─────────────────────────────────────────────────────────────────────────

/** A fresh, empty history — the state every frame opens (and re-opens, on a reload) with. */
export function freshHistory(): History {
  return { past: [], future: [], coalesceKey: undefined };
}

/**
 * The default `name` a from-scratch buffer opens with; it slugs cleanly so the first-save dialog can prefill
 * `untitled.workflow.json`.
 */
const NEW_FILE_DEFAULT_NAME = "untitled";

/** A fresh loading frame for `path`: no ETag, an empty save-point and history until it opens. `descendedVia`
 * carries the parent `workflow` block id through a descent or reload so the breadcrumb run badge survives. */
export function loadingFrame(
  path: string | null,
  descendedVia: string | undefined,
  loadSeq: number,
  template?: TemplateSource,
): Frame {
  // It targets an on-disk file, so it is `written`; a still-loading frame is not yet leased regardless.
  return {
    path,
    written: true,
    state: { phase: "loading" },
    etag: null,
    baseline: "",
    openedBytes: "",
    history: freshHistory(),
    descendedVia,
    loadSeq,
    template,
  };
}

/** A from-scratch buffer's frame: an empty, id-bearing **unwritten** workflow with no ETag and no lease
 * until its first save. `baseline` is `""`, so it reads dirty from open, which keeps Save live. */
export function scratchFrame(
  path: string | null = null,
  refParent?: { depth: number; nodeId: string },
): Frame {
  const name = path === null ? NEW_FILE_DEFAULT_NAME : stemName(path);
  const file: WorkflowFile = { format: FORMAT_VERSION, id: crypto.randomUUID(), name, body: [] };
  const openedBytes = canonicalSerialize(file);
  return {
    path,
    written: false,
    state: { phase: "open", result: { status: "opened", file, idsStamped: false } },
    etag: null,
    baseline: "",
    openedBytes,
    history: freshHistory(),
    refParent,
    loadSeq: null,
  };
}

/**
 * The default workflow `name` for a create-new child, from its filename stem (falling back when the stem is not a
 * legal name).
 */
export function stemName(path: string): string {
  const stem = basename(path).replace(/\.workflow\.json$/i, "");
  return /^[a-z][a-z0-9-]*$/.test(stem) ? stem : NEW_FILE_DEFAULT_NAME;
}

/** Advance a frame to a new **save-point** (ADR 0030): the written bytes become the baseline, the fresh ETag
 * the next `If-Match`, and `written` flips so a first-saved child acquires its lease and launch enables. */
function withSavePoint(frame: Frame, etag: string, savedBytes: string): Frame {
  return { ...frame, written: true, etag, baseline: savedBytes, openedBytes: savedBytes };
}

/** The frame's opened result, or `null`; the one predicate the canvas, the toolbar and the save path all ask. */
export function openedResultOf(frame: Frame | undefined): OpenedResult | null {
  if (frame && frame.state.phase === "open" && frame.state.result.status === "opened")
    return frame.state.result;
  return null;
}

/** The one definition of **dirty** (ADR 0030): an opened frame's canonical serialization no longer equals
 * its `baseline`. Launch, the Save button and the dirty badge all read this, so the three cannot drift. */
export function frameDirty(frame: Frame | undefined): boolean {
  const opened = openedResultOf(frame);
  if (!frame || !opened) return false;
  return canonicalSerialize(opened.file) !== frame.baseline;
}

/** Would discarding this frame lose work? Dirty, except a from-scratch buffer still exactly as it opened
 * (it reads dirty only to keep Save live, and holds nothing the author made). */
export function frameHasUnsavedWork(frame: Frame | undefined): boolean {
  if (!frameDirty(frame)) return false;
  return frame!.written || canonicalSerialize(openedResultOf(frame)!.file) !== frame!.openedBytes;
}

/** Has the active frame an edit to undo? Drives the toolbar's Undo button and its keyboard peer. */
export function frameCanUndo(frame: Frame | undefined): boolean {
  return frame !== undefined && frame.history.past.length > 0;
}

/** Has the active frame an undo to redo? Drives the toolbar's Redo button and its keyboard peer. */
export function frameCanRedo(frame: Frame | undefined): boolean {
  return frame !== undefined && frame.history.future.length > 0;
}

// ── The session state and its actions ──────────────────────────────────────────────────────────────

/** The Designer's edit mode, picked with the toolbar's Workflow | Template switch. Switching clears the canvas. */
export type EditMode = "workflow" | "template";

export interface SessionState {
  mode: EditMode;
  /** The navigation **trail**, root file first. The active frame is `frames[activeIndex]`, not the tip. */
  frames: Frame[];
  activeIndex: number;
  saveState: SaveState;
}

/** The empty session before any file opens. */
export const initialSessionState: SessionState = {
  mode: "workflow",
  frames: [],
  activeIndex: 0,
  saveState: { phase: "idle" },
};

/**
 * Every transition the session makes. The reducer owns each **decision**; the hook performs the I/O those call for.
 */
export type SessionAction =
  /** Open `path` as a fresh root, discarding any current stack — one loading frame, active index 0. */
  | { type: "openLoading"; path: string; loadSeq: number }
  /** Open a `*.step-template.json` as author mode's root, discarding any current stack. */
  | { type: "openTemplateLoading"; template: TemplateSource; loadSeq: number }
  /** Start a from-scratch buffer as a fresh root, discarding any current stack. */
  | { type: "newFile" }
  /** Start a new, unsaved template in template mode, discarding any current stack. */
  | { type: "newTemplate" }
  /** Switch the edit mode, discarding any current stack: the canvas is empty in the new mode. */
  | { type: "switchMode"; mode: EditMode }
  /**
   * Descend across the active file's `workflow`-ref: re-enter a frame just ahead that already holds the
   * target (a live, possibly-dirty child is not reloaded out from under the author), otherwise truncate the
   * forward trail and push a loading frame. A path-less root has no ref to resolve, so the action is a no-op.
   */
  | { type: "descend"; ref: string; nodeId: string; loadSeq: number }
  /** Descend into a fresh, unwritten, path-less create-new child linked back to `parentNodeId`. */
  | { type: "descendNewUnbound"; parentNodeId: string }
  /** Make the breadcrumb entry at `index` active — an ascend or a forward re-entry; no frame is discarded. */
  | { type: "goTo"; index: number }
  /** Commit an edit to the active frame's opened file, folding a run of field edits that share an identity. */
  | { type: "applyEdit"; next: WorkflowFile; key?: EditKey }
  /** Undo the active frame's last edit. A no-op when its past stack is empty. */
  | { type: "undo" }
  /** Redo the active frame's last undo. A no-op when its future stack is empty. */
  | { type: "redo" }
  /**
   * Re-fetch the active frame from disk; a no-op when nothing is reloadable (an unwritten buffer, or a fetch that
   * would discard the authored buffer).
   */
  | { type: "reload"; loadSeq: number }
  /** A file fetch-and-open landed. Patched in only when the frame at `depth` still awaits `loadSeq` — the pure
   * staleness guard that drops a result whose destination the author already left. */
  | {
      type: "loadLanded";
      depth: number;
      path: string | null;
      loadSeq: number;
      frameState: FrameState;
      etag: string | null;
      baseline: string;
      openedBytes: string;
    }
  /** A `PUT` is in flight — the transient `saving` phase. */
  | { type: "saveStarted" }
  /** A written file's save succeeded: advance its save-point, guarded on the frame at `depth` still holding `path`. */
  | { type: "saved"; depth: number; path: string; etag: string; savedBytes: string }
  /**
   * A from-scratch root's first save succeeded: the frame adopts the server `relativePath`, drops its `refParent`,
   * and back-fills the parent's `ref`.
   */
  | { type: "newFileSaved"; depth: number; etag: string; savedBytes: string; relativePath: string }
  /** An author-mode write-back succeeded, guarded on the frame at `depth` still editing template `id`. */
  | { type: "templateSaved"; depth: number; id: string; etag: string; savedBytes: string }
  /** An author-mode Save-As created a new template: the frame now edits it and its fresh file, clean at `etag`.
   * The history starts fresh — an undo past the Save-As would restore the old template's id. */
  | {
      type: "templateSavedAs";
      depth: number;
      fromId: string | null;
      template: TemplateSource;
      file: WorkflowFile;
      etag: string;
    }
  /** A workflow-mode Save as… wrote a copy at `relativePath`: the session becomes that saved file as a fresh root. */
  | {
      type: "detachedSaved";
      depth: number;
      fromId: string;
      file: WorkflowFile;
      relativePath: string;
      etag: string;
    }
  /** The root file named by `plan` was deleted: clear to an empty canvas if still open, else only reset the phase. */
  | { type: "deleted"; plan: DeletePlan }
  /** Set the transient save phase directly. */
  | { type: "setSaveState"; saveState: SaveState };

/** The save state with nothing in flight and nothing to report. */
export const IDLE: SaveState = { phase: "idle" };

/** The one pure `(state, action) => state` behind the whole session. */
export function reduceSession(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "openLoading":
      return {
        mode: "workflow",
        frames: [loadingFrame(action.path, undefined, action.loadSeq)],
        activeIndex: 0,
        saveState: IDLE,
      };

    case "newFile":
      return { mode: "workflow", frames: [scratchFrame()], activeIndex: 0, saveState: IDLE };

    case "newTemplate":
      return { mode: "template", frames: [scratchFrame()], activeIndex: 0, saveState: IDLE };

    case "switchMode":
      return { mode: action.mode, frames: [], activeIndex: 0, saveState: IDLE };

    case "deleted": {
      const root = state.frames[0];
      const plan = action.plan;
      const stillOpen =
        plan.kind === "template"
          ? root?.template?.id === plan.id
          : root?.path === plan.path && !root.template;
      if (!stillOpen) return { ...state, saveState: IDLE };
      return { mode: state.mode, frames: [], activeIndex: 0, saveState: { phase: "deleted" } };
    }

    case "openTemplateLoading":
      return {
        mode: "template",
        frames: [loadingFrame(null, undefined, action.loadSeq, action.template)],
        activeIndex: 0,
        saveState: IDLE,
      };

    case "descend": {
      const depth = state.activeIndex;
      const active = state.frames[depth];
      // No active frame, or a from-scratch one with no path: there is no file to resolve the ref against.
      if (!active || active.path === null) return state;
      const path = resolveRefPath(active.path, action.ref);
      // Re-entry down the same trail: the frame just ahead already holds the target, so return to its live
      // buffer rather than reloading a dirty child out from under the author.
      const ahead = state.frames[depth + 1];
      if (ahead && ahead.path === path) {
        return { ...state, activeIndex: depth + 1, saveState: IDLE };
      }
      // Otherwise truncate the forward trail and load fresh; `nodeId` feeds the breadcrumb's run badge.
      return {
        mode: state.mode,
        frames: [
          ...state.frames.slice(0, depth + 1),
          loadingFrame(path, action.nodeId, action.loadSeq),
        ],
        activeIndex: depth + 1,
        saveState: IDLE,
      };
    }

    case "descendNewUnbound": {
      const depth = state.activeIndex;
      if (!state.frames[depth]) return state;
      const childDepth = depth + 1;
      const child = scratchFrame(null, { depth, nodeId: action.parentNodeId });
      return {
        mode: state.mode,
        frames: [...state.frames.slice(0, childDepth), child],
        activeIndex: childDepth,
        saveState: IDLE,
      };
    }

    case "goTo": {
      const activeIndex =
        action.index < 0 || action.index >= state.frames.length ? state.activeIndex : action.index;
      return { ...state, activeIndex, saveState: IDLE };
    }

    case "applyEdit": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened) return { ...state, saveState: IDLE };
      // A field edit whose identity matches the run in progress folds — undo jumps to where the run began.
      // Any other edit pushes the present as a new entry; either way redo is cleared.
      const fold = action.key !== undefined && sameEditKey(action.key, frame.history.coalesceKey);
      const past = fold ? frame.history.past : [...frame.history.past, opened.file];
      return withBuffer(state, depth, frame, action.next, {
        past,
        future: [],
        coalesceKey: action.key,
      });
    }

    case "undo": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      // Nothing to undo is a true no-op, keeping a standing "Saved"/conflict phase.
      if (!frame || !opened || frame.history.past.length === 0) return state;
      const past = frame.history.past.slice();
      const restored = past.pop()!;
      // The present moves to the redo stack; clean re-derives against the unchanged baseline, so an undo
      // past the save-point re-dirties for free (ADR 0030). Closing the coalesce run opens a fresh entry next.
      return withBuffer(state, depth, frame, restored, {
        past,
        future: [opened.file, ...frame.history.future],
        coalesceKey: undefined,
      });
    }

    case "redo": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened || frame.history.future.length === 0) return state;
      const future = frame.history.future.slice();
      const restored = future.shift()!;
      return withBuffer(state, depth, frame, restored, {
        past: [...frame.history.past, opened.file],
        future,
        coalesceKey: undefined,
      });
    }

    case "reload": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      // An unwritten buffer has no on-disk bytes to re-fetch; a template frame has no path but re-reads by id.
      if (!frame || !frame.written || (frame.path === null && !frame.template)) return state;
      const frames = state.frames.slice();
      // A reload keeps the frame's descent origin, so a re-fetched child still badges its run status.
      frames[depth] = loadingFrame(frame.path, frame.descendedVia, action.loadSeq, frame.template);
      return { ...state, frames, saveState: IDLE };
    }

    case "loadLanded": {
      const { depth, loadSeq } = action;
      // The staleness guard: patch in only when the frame at `depth` still awaits this exact fetch; a frame
      // the author left, replaced, or that already landed holds a different number, so its result is dropped.
      if (state.frames[depth]?.loadSeq !== loadSeq) return state;
      const frames = state.frames.slice();
      frames[depth] = {
        path: action.path,
        written: true,
        state: action.frameState,
        etag: action.etag,
        baseline: action.baseline,
        openedBytes: action.openedBytes,
        history: freshHistory(),
        // Carry the descent origin and template across the fetch.
        descendedVia: frames[depth]?.descendedVia,
        loadSeq: null,
        template: frames[depth]?.template,
      };
      return { ...state, frames };
    }

    case "saveStarted":
      return { ...state, saveState: { phase: "saving" } };

    // A landing save advances the frame only if it is still the one written; each case below states what
    // "still the saved frame" means for its door, and `landSave` does the rest.
    case "saved":
      return landSave(
        state,
        action.depth,
        (frame) => frame.path === action.path,
        (frame) =>
          withFrame(state, action.depth, withSavePoint(frame, action.etag, action.savedBytes)),
      );

    case "templateSaved":
      return landSave(
        state,
        action.depth,
        (frame) => frame.template?.id === action.id,
        (frame) =>
          withFrame(state, action.depth, withSavePoint(frame, action.etag, action.savedBytes)),
      );

    // A from-scratch buffer's first save: it is still that buffer while it is unwritten and path-less.
    case "newFileSaved":
      return landSave(
        state,
        action.depth,
        (frame) => !frame.written && frame.path === null,
        (frame) => landNewFile(state, frame, action),
      );

    // `fromId: null` is a new template's first save: the frame held no template yet.
    case "templateSavedAs":
      return landSave(
        state,
        action.depth,
        (frame) => (frame.template?.id ?? null) === action.fromId,
        (frame, opened) =>
          withFrame(state, action.depth, {
            ...frame,
            template: action.template,
            ...savedBuffer(action.file, action.etag, opened),
          }),
      );

    // A detached copy saved as a plain workflow replaces the whole session with that one file.
    case "detachedSaved":
      return landSave(
        state,
        action.depth,
        (_frame, opened) => opened.file.id === action.fromId,
        () => ({
          mode: "workflow",
          frames: [
            { path: action.relativePath, loadSeq: null, ...savedBuffer(action.file, action.etag) },
          ],
          activeIndex: 0,
          saveState: IDLE,
        }),
      );

    case "setSaveState":
      return { ...state, saveState: action.saveState };
  }
}

/** `state` with the frame at `depth` replaced. */
function withFrame(state: SessionState, depth: number, frame: Frame): SessionState {
  const frames = state.frames.slice();
  frames[depth] = frame;
  return { ...state, frames };
}

/** An edit, undo or redo: the active frame's buffer becomes `file`, under `history`. */
function withBuffer(
  state: SessionState,
  depth: number,
  frame: Frame,
  file: WorkflowFile,
  history: History,
): SessionState {
  const opened = openedResultOf(frame)!;
  const next = withFrame(state, depth, {
    ...frame,
    state: { phase: "open", result: { ...opened, file } },
    history,
  });
  return { ...next, activeIndex: depth, saveState: IDLE };
}

/**
 * Land a save on the frame at `depth`; the phase is `saved` either way, but `land` runs only while `stillSaved`
 * holds.
 */
function landSave(
  state: SessionState,
  depth: number,
  stillSaved: (frame: Frame, opened: OpenedResult) => boolean,
  land: (frame: Frame, opened: OpenedResult) => SessionState,
): SessionState {
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  const landed = frame && opened && stillSaved(frame, opened) ? land(frame, opened) : state;
  return { ...landed, saveState: { phase: "saved" } };
}

/** A buffer that now matches what is on disk: written, open on `file`, its save point at `file`'s bytes. */
function savedBuffer(
  file: WorkflowFile,
  etag: string,
  opened?: OpenedResult,
): Omit<Frame, "path" | "loadSeq"> {
  const bytes = canonicalSerialize(file);
  return {
    written: true,
    state: {
      phase: "open",
      result: opened ? { ...opened, file } : { status: "opened", file, idsStamped: false },
    },
    etag,
    baseline: bytes,
    openedBytes: bytes,
    history: freshHistory(),
  };
}

/**
 * A create-new child's first save: the child adopts its server path and drops its `refParent`, and the parent's
 * `workflow` node gets its `ref` back-filled.
 */
function landNewFile(
  state: SessionState,
  child: Frame,
  action: Extract<SessionAction, { type: "newFileSaved" }>,
): SessionState {
  const frames = state.frames.slice();
  frames[action.depth] = {
    ...withSavePoint(child, action.etag, action.savedBytes),
    path: action.relativePath,
    refParent: undefined,
  };
  const link = child.refParent;
  const parent = link ? frames[link.depth] : undefined;
  const parentResult = openedResultOf(parent);
  if (link && parent && parentResult && parent.path !== null) {
    const node = findById(parentResult.file.body, link.nodeId);
    if (node && node.type === "workflow") {
      const ref = relativeRefPath(parent.path, action.relativePath);
      const nextParent = unwrapEdit(
        editFile(parentResult.file, {
          kind: "replace",
          id: link.nodeId,
          node: { ...node, ref } as WorkflowNode,
        }),
      );
      frames[link.depth] = {
        ...parent,
        state: { phase: "open", result: { ...parentResult, file: nextParent } },
      };
    }
  }
  return { ...state, frames };
}

// ── The save doors, as decisions the hook performs ──────────────────────────────────────────────────

/** What the Save button would do, or `null`. The door is the session's own choice: **overwrite** under the
 * read's `If-Match` ETag (ADR 0016), **create** exclusively at the pre-assigned path, or **template**
 * write-back by id (`PUT /v0/templates/:id`). A from-scratch root picks its path in the first-save dialog. */
export type SavePlan =
  | {
      kind: "overwrite";
      depth: number;
      path: string;
      file: WorkflowFile;
      ifMatch: string | undefined;
    }
  | { kind: "create"; depth: number; path: string; file: WorkflowFile; ifMatch: undefined }
  | {
      kind: "template";
      depth: number;
      id: string;
      template: TemplateSource;
      file: WorkflowFile;
      ifMatch: string;
    };

export function planSave(state: SessionState): SavePlan | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  if (frame?.template && opened) {
    // The read always carries an ETag; an empty token would only earn the honest `412`.
    return {
      kind: "template",
      depth,
      id: frame.template.id,
      template: frame.template,
      file: opened.file,
      ifMatch: frame.etag ?? "",
    };
  }
  if (!frame || !opened || frame.path === null) return null;
  return frame.written
    ? {
        kind: "overwrite",
        depth,
        path: frame.path,
        file: opened.file,
        ifMatch: frame.etag ?? undefined,
      }
    : { kind: "create", depth, path: frame.path, file: opened.file, ifMatch: undefined };
}

/** What the Delete button would remove, or `null`. Delete acts on the **root** file only: a written file
 * through `DELETE /v0/workflows/file` under the read's `If-Match`, a user template through
 * `DELETE /v0/templates/:id`. A shipped template and a never-saved buffer have no plan. */
export type DeletePlan =
  | { kind: "workflow"; path: string; ifMatch: string }
  | { kind: "template"; id: string; name: string };

export function planDelete(state: SessionState): DeletePlan | null {
  if (state.activeIndex !== 0) return null;
  const frame = state.frames[0];
  if (!frame || frame.state.phase !== "open") return null;
  if (frame.template)
    return frame.template.readOnly
      ? null
      : { kind: "template", id: frame.template.id, name: frame.template.name };
  if (!frame.written || frame.path === null || frame.etag === null) return null;
  return { kind: "workflow", path: frame.path, ifMatch: frame.etag };
}

/** What the first-save dialog's target would do, or `null` when the active frame is not a from-scratch root. */
export interface NewFileSavePlan {
  depth: number;
  file: WorkflowFile;
}

export function planNewFileSave(state: SessionState): NewFileSavePlan | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  // Only a from-scratch root picks its path here; a create-new child and a saved frame go through `planSave`.
  if (!frame || !opened || frame.written || frame.path !== null) return null;
  return { depth, file: opened.file };
}

/** What the two author-mode Save-As doors start from: the active template frame's buffer and its source, or
 * `null`. Each door derives its own new identity from `file`. */
export interface TemplateSaveAsPlan {
  depth: number;
  template: TemplateSource;
  file: WorkflowFile;
}

export function planTemplateSaveAs(state: SessionState): TemplateSaveAsPlan | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  if (!frame?.template || !opened) return null;
  return { depth, template: frame.template, file: opened.file };
}

/** What a workflow-mode Save as… starts from: the active opened buffer in workflow mode, or `null`. */
export function planWorkflowSaveAs(state: SessionState): NewFileSavePlan | null {
  const depth = state.activeIndex;
  const opened = openedResultOf(state.frames[depth]);
  if (state.mode !== "workflow" || !opened) return null;
  return { depth, file: opened.file };
}

/**
 * What a new template's first save starts from: the active template-mode buffer that holds no template yet, or
 * `null`.
 */
export function planNewTemplateSave(state: SessionState): NewFileSavePlan | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  if (state.mode !== "template" || !frame || frame.template || !opened) return null;
  return { depth, file: opened.file };
}
