import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import type { OpenResult } from "./open-workflow.js";
import { findById, replaceNode } from "./edit-tree.js";
import { basename, relativeRefPath } from "./resolve-ref.js";
import { canonicalSerialize } from "./serialize.js";

/**
 * The Designer session's **pure state machine** (#367–#391, extracted from `use-open-file.ts`). Every
 * transition the open-and-navigate session makes — open, descend, edit, undo/redo, and the save-point
 * advance a save lands — is a case of `reduceSession`, a pure `(state, action) => state`. The hook
 * (`useOpenFile`) is the thin adapter around it: it runs the async `client` fetch/PUT, guards a stale
 * completion with a monotonic token, then **dispatches the result as an action**. No promise, no
 * `client`, and no wall-clock timing lives here, so the whole session — the navigation trail, the
 * per-frame undo history, the coalesced field-edit fold, the save-point advance, the create-new ref
 * back-fill — is testable with neither React nor a stub server, the way `validated-draft.ts` made the
 * pane fields testable off the render path.
 */

// ── Frame types ────────────────────────────────────────────────────────────────────────────────────

/** One file on the navigation stack: its path, where its fetch-and-open got to, and its save-point. */
export interface Frame {
  /**
   * The file's project-relative path, or **`null`** for a from-scratch buffer that holds no path until
   * its first save (#390). A `null`-path frame takes no lease and cannot launch; `saveNewFile` chooses
   * the path at first save, after which it is a saved frame like any other.
   */
  path: string | null;
  /**
   * Has this buffer been **persisted to disk**? A saved file is `true`; a from-scratch buffer (#390) and a
   * create-new nested child (#391) are `false` until their first save, even though the child already carries
   * its pre-assigned `path`. It is the discriminator the from-scratch rule reads: an **unwritten** frame
   * takes no lease and cannot launch, and its first save is an **exclusive create** (no `If-Match`, ADR 0016).
   */
  written: boolean;
  state: FrameState;
  /**
   * The `If-Match` ETag for the next save — the strong ETag of the bytes this frame opened, or of the
   * bytes the last successful save wrote. `null` when a proxy stripped the read route's `ETag` header.
   */
  etag: string | null;
  /**
   * The **baseline**: the on-disk bytes the frame last synced (ADR 0030) — the raw text this frame opened,
   * or `canonicalSerialize(buffer)` of the bytes the last `200` save wrote. The buffer is **clean** when
   * `canonicalSerialize(buffer) === baseline`, **dirty** otherwise. It advances only on a `200` save.
   */
  baseline: string;
  /**
   * `canonicalSerialize(buffer)` at the last save-point. It only steers the badge's wording (an id-stamp-only
   * dirty vs an authored edit); dirtiness is the `baseline` comparison. It differs from `baseline` only at
   * open of a non-canonical file; a save aligns them.
   */
  openedBytes: string;
  /** This frame's own undo/redo stack (#389). Independent per open file; survives this frame's saves. */
  history: History;
  /**
   * A create-new nested-ref child's back-link to the `workflow` node that spawned it (#391): the parent
   * frame's `depth` on the trail and that node's `id`. Consumed at the child's **first save**, which
   * back-fills the parent node's `ref` from the path the child was saved to. `undefined` otherwise.
   */
  refParent?: { depth: number; nodeId: string };
  /**
   * The `workflow` block **in the parent frame** whose ref this frame descended through (#372, run
   * projection on the breadcrumb): that node's durable `id`. It lets the breadcrumb badge this descent
   * crumb with the parent node's projected run status — the sub-workflow's own verdict — so a nested run
   * trail reads `parent failed / child failed`, not just the root. `undefined` on a root frame and on a
   * create-new child (which carries `refParent` instead until its first save binds it).
   */
  descendedVia?: string;
}

/** A frame is fetching, failed to fetch, or has an open outcome (which may itself be a legible refusal). */
export type FrameState =
  | { phase: "loading" }
  | { phase: "fetch-error"; message: string }
  | { phase: "open"; result: OpenResult };

/**
 * The undo/redo history of one frame (#389). The **present** is the frame's open buffer (`state.result.file`),
 * not held here; `past` and `future` are the snapshots either side of it. One entry per structural edit or
 * per **coalesced** field-edit run. It is **per-frame** and **survives a save** (the save advances the
 * baseline, not the history), so undoing past the save-point re-dirties the buffer. Redo is cleared by any
 * new edit.
 */
export interface History {
  /** Buffers before the present, oldest first; the last is the next undo target. */
  past: WorkflowFile[];
  /** Buffers ahead of the present (redo), next-redo first; cleared by any new edit. */
  future: WorkflowFile[];
  /**
   * The coalesce key of the in-progress field run, or `undefined` when the last commit closed a run. A field
   * edit whose key equals this folds into the current entry; any other key, or a structural edit, opens one.
   */
  coalesceKey: string | undefined;
}

/**
 * The state of the active frame's save (#371, ADR 0016) — a transient UI phase, not the dirty relation:
 * `saved` shows the confirmation after a `200`; `conflict` is the `412` stale-write; `error` is any other
 * write failure.
 */
export type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved" }
  | { phase: "conflict"; message: string }
  | { phase: "error"; message: string };

/** A frame's opened workflow result, or `null` when it is loading, failed to fetch, or is a refusal. */
export type OpenedResult = Extract<OpenResult, { status: "opened" }>;

// ── Frame helpers (pure) ─────────────────────────────────────────────────────────────────────────

/** A fresh, empty history — the state every frame opens (and re-opens, on a reload) with. */
export function freshHistory(): History {
  return { past: [], future: [], coalesceKey: undefined };
}

/**
 * The default `name` a from-scratch buffer opens with (#390). It slugs cleanly to a filename
 * (`^[a-z][a-z0-9-]*$`), so the first-save dialog can prefill `untitled.workflow.json`.
 */
const NEW_FILE_DEFAULT_NAME = "untitled";

/**
 * A fresh loading frame for `path`: no ETag, an empty save-point, and an empty history until it opens.
 * `descendedVia` carries the parent `workflow` block id through the load (a descent) and through a reload,
 * so the breadcrumb's run badge survives the frame's fetch; `undefined` for a root open.
 */
export function loadingFrame(path: string, descendedVia?: string): Frame {
  // It targets an on-disk file, so it is `written`; the lease/launch gates read `openedResultOf` too, so
  // a still-loading frame is not yet leased regardless.
  return { path, written: true, state: { phase: "loading" }, etag: null, baseline: "", openedBytes: "", history: freshHistory(), descendedVia };
}

/**
 * A from-scratch buffer's frame: an empty, id-bearing **unwritten** workflow, with no ETag and no lease
 * until its first save. Its `baseline` is the empty string, so the buffer reads dirty from open through
 * `frameDirty`, which keeps Save live. `path` is `null` for a new **root** (#390), or the pre-assigned
 * child path for a create-new nested ref (#391); either way the frame is `written: false`.
 */
export function scratchFrame(path: string | null = null, refParent?: { depth: number; nodeId: string }): Frame {
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
  };
}

/**
 * The default workflow `name` for a create-new child, taken from its filename stem. It falls back to the
 * from-scratch default when a stem does not slug to a legal name (`^[a-z][a-z0-9-]*$`).
 */
function stemName(path: string): string {
  const stem = basename(path).replace(/\.workflow\.json$/i, "");
  return /^[a-z][a-z0-9-]*$/.test(stem) ? stem : NEW_FILE_DEFAULT_NAME;
}

/**
 * Advance a frame to a new **save-point** (ADR 0030): the buffer just written becomes the baseline and the
 * write route's fresh ETag becomes the next `If-Match`. `openedBytes` moves too, and `written` flips so a
 * first-saved child acquires its lease and launch enables.
 */
function withSavePoint(frame: Frame, etag: string, savedBytes: string): Frame {
  return { ...frame, written: true, etag, baseline: savedBytes, openedBytes: savedBytes };
}

/**
 * The opened result of a frame, or `null`. The one predicate — "the frame is open and its open succeeded" —
 * that the canvas, the toolbar, and the save path all ask, kept in one place so the call sites cannot drift.
 */
export function openedResultOf(frame: Frame | undefined): OpenedResult | null {
  if (frame && frame.state.phase === "open" && frame.state.result.status === "opened") return frame.state.result;
  return null;
}

/**
 * The one definition of **dirty** (ADR 0030): an opened frame's buffer is dirty when its canonical
 * serialization no longer equals the frame's `baseline`. Launch (ADR 0025), the Save button, and the dirty
 * badge all read this one content relation, so the three cannot drift.
 */
export function frameDirty(frame: Frame | undefined): boolean {
  const opened = openedResultOf(frame);
  if (!frame || !opened) return false;
  return canonicalSerialize(opened.file) !== frame.baseline;
}

/** Has the active frame an edit to undo (#389)? Drives the toolbar's Undo button and its keyboard peer. */
export function frameCanUndo(frame: Frame | undefined): boolean {
  return frame !== undefined && frame.history.past.length > 0;
}

/** Has the active frame an undo to redo (#389)? Drives the toolbar's Redo button and its keyboard peer. */
export function frameCanRedo(frame: Frame | undefined): boolean {
  return frame !== undefined && frame.history.future.length > 0;
}

// ── The session state and its actions ──────────────────────────────────────────────────────────────

/** The whole open-and-navigate session state the reducer owns: the trail, the active frame, the save phase. */
export interface SessionState {
  /** The navigation **trail**, root file first (#367). The active frame is `frames[activeIndex]`, not the tip. */
  frames: Frame[];
  /** The index of the active frame in `frames` — what the canvas renders and every edit/save op targets. */
  activeIndex: number;
  /** The active frame's save state — drives the save button and the stale-write conflict banner. */
  saveState: SaveState;
}

/** The empty session before any file opens. */
export const initialSessionState: SessionState = { frames: [], activeIndex: 0, saveState: { phase: "idle" } };

/**
 * Every transition the session makes. The **sync** actions are dispatched straight from a hook callback
 * (`openLoading`, `newFile`, `descendLoading`, `descendReuse`, `descendNewUnbound`, `goTo`, `applyEdit`,
 * `undo`, `redo`, `reloadLoading`); the **async-result** actions (`loadLanded`, `saved`, `newFileSaved`)
 * are dispatched by the hook once a `client` call resolves, carrying the outcome. `saveStarted` /
 * `setSaveState` move the transient save phase. The hook's monotonic load token (a wall-clock pre-gate)
 * decides whether a result action is dispatched at all; the reducer's own depth+path re-check is the pure
 * invariant that drops a landed result whose frame the trail no longer holds.
 */
export type SessionAction =
  /** Open `path` as a fresh root, discarding any current stack — one loading frame, active index 0. */
  | { type: "openLoading"; path: string }
  /** Start a from-scratch buffer as a fresh root (#390), discarding any current stack. */
  | { type: "newFile" }
  /**
   * Truncate the forward trail and push a loading frame for a fresh `workflow`-ref descent (#367).
   * `nodeId` is the parent `workflow` block the descent crossed, kept on the child frame for the
   * breadcrumb's run badge (#372).
   */
  | { type: "descendLoading"; path: string; nodeId: string }
  /** Re-enter the frame just ahead down the same trail (a re-descent to a live, possibly-dirty child). */
  | { type: "descendReuse" }
  /** Descend into a fresh, unwritten, path-less create-new child linked back to `parentNodeId` (#391). */
  | { type: "descendNewUnbound"; parentNodeId: string }
  /** Make the breadcrumb entry at `index` active — an ascend or a forward re-entry; no frame is discarded. */
  | { type: "goTo"; index: number }
  /** Commit an edit to the active frame's opened file, folding a coalesced field run to one undo entry (#389). */
  | { type: "applyEdit"; next: WorkflowFile; coalesce?: string }
  /** Undo the active frame's last edit (#389). A no-op when its past stack is empty. */
  | { type: "undo" }
  /** Redo the active frame's last undo (#389). A no-op when its future stack is empty. */
  | { type: "redo" }
  /** Re-fetch the active written frame at `depth`/`path` — replace it with a loading frame. */
  | { type: "reloadLoading"; depth: number; path: string }
  /**
   * A file fetch-and-open landed. Patched in **only** when the frame at `depth` still holds `path` — the pure
   * staleness guard that drops a result whose frame the author already left (the token pre-gate is the hook's).
   */
  | { type: "loadLanded"; depth: number; path: string; frameState: FrameState; etag: string | null; baseline: string; openedBytes: string }
  /** A `PUT` is in flight — the transient `saving` phase. */
  | { type: "saveStarted" }
  /**
   * A written file's (or create-new child's) save succeeded: advance its save-point, guarded on the frame at
   * `depth` still holding `path`. Always sets the `saved` phase.
   */
  | { type: "saved"; depth: number; path: string; etag: string; savedBytes: string }
  /**
   * A from-scratch root's first save succeeded (#390): the frame adopts the server `relativePath`, drops its
   * `refParent`, and back-fills a create-new parent's `workflow` node `ref` (#391). Guarded on the frame at
   * `depth` still being unwritten and path-less. Always sets the `saved` phase.
   */
  | { type: "newFileSaved"; depth: number; etag: string; savedBytes: string; relativePath: string }
  /** Set the transient save phase directly — a failure mapping (`conflict`/`error`) or a reset to `idle`. */
  | { type: "setSaveState"; saveState: SaveState };

const IDLE: SaveState = { phase: "idle" };

/** The one pure `(state, action) => state` behind the whole session (see the module header). */
export function reduceSession(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "openLoading":
      return { frames: [loadingFrame(action.path)], activeIndex: 0, saveState: IDLE };

    case "newFile":
      return { frames: [scratchFrame()], activeIndex: 0, saveState: IDLE };

    case "descendLoading": {
      const childDepth = state.activeIndex + 1;
      return { frames: [...state.frames.slice(0, childDepth), loadingFrame(action.path, action.nodeId)], activeIndex: childDepth, saveState: IDLE };
    }

    case "descendReuse":
      return { ...state, activeIndex: state.activeIndex + 1, saveState: IDLE };

    case "descendNewUnbound": {
      const depth = state.activeIndex;
      const childDepth = depth + 1;
      const child = scratchFrame(null, { depth, nodeId: action.parentNodeId });
      return { frames: [...state.frames.slice(0, childDepth), child], activeIndex: childDepth, saveState: IDLE };
    }

    case "goTo": {
      const activeIndex = action.index < 0 || action.index >= state.frames.length ? state.activeIndex : action.index;
      return { ...state, activeIndex, saveState: IDLE };
    }

    case "applyEdit": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened) return { ...state, saveState: IDLE };
      // Record an undo entry (#389). A field edit whose key matches the run in progress **folds** — the
      // present buffer is the run's intermediate, dropped so undo jumps to where the run began. Any other
      // key, or a structural edit (no key), pushes the present as a new entry. Either way redo is cleared.
      const fold = action.coalesce !== undefined && action.coalesce === frame.history.coalesceKey;
      const past = fold ? frame.history.past : [...frame.history.past, opened.file];
      const frames = state.frames.slice();
      frames[depth] = {
        ...frame,
        state: { phase: "open", result: { ...opened, file: action.next } },
        history: { past, future: [], coalesceKey: action.coalesce },
      };
      return { frames, activeIndex: depth, saveState: IDLE };
    }

    case "undo": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened || frame.history.past.length === 0) return { ...state, saveState: IDLE };
      const past = frame.history.past.slice();
      const restored = past.pop()!;
      // The present moves to the redo stack; clean re-derives from `restored` against the (unchanged)
      // baseline, so an undo past the save-point re-dirties the buffer for free (ADR 0030). Close any
      // coalesce run so a following field edit opens a fresh entry rather than folding into the undone one.
      const frames = state.frames.slice();
      frames[depth] = {
        ...frame,
        state: { phase: "open", result: { ...opened, file: restored } },
        history: { past, future: [opened.file, ...frame.history.future], coalesceKey: undefined },
      };
      return { frames, activeIndex: depth, saveState: IDLE };
    }

    case "redo": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened || frame.history.future.length === 0) return { ...state, saveState: IDLE };
      const future = frame.history.future.slice();
      const restored = future.shift()!;
      const frames = state.frames.slice();
      frames[depth] = {
        ...frame,
        state: { phase: "open", result: { ...opened, file: restored } },
        history: { past: [...frame.history.past, opened.file], future, coalesceKey: undefined },
      };
      return { frames, activeIndex: depth, saveState: IDLE };
    }

    case "reloadLoading": {
      const frames = state.frames.slice();
      // A reload keeps the frame's descent origin, so a re-fetched child still badges its run status.
      frames[action.depth] = loadingFrame(action.path, frames[action.depth]?.descendedVia);
      return { ...state, frames, saveState: IDLE };
    }

    case "loadLanded": {
      const { depth, path } = action;
      // The pure staleness guard: patch in only when the frame at `depth` still holds `path` — the author
      // may have descended, popped, or re-opened while the fetch was in flight. A loaded frame is `written`.
      if (depth >= state.frames.length || state.frames[depth]?.path !== path) return state;
      const frames = state.frames.slice();
      frames[depth] = {
        path,
        written: true,
        state: action.frameState,
        etag: action.etag,
        baseline: action.baseline,
        openedBytes: action.openedBytes,
        history: freshHistory(),
        // Carry the descent origin across the fetch, so the opened child keeps its breadcrumb run badge.
        descendedVia: frames[depth]?.descendedVia,
      };
      return { ...state, frames };
    }

    case "saveStarted":
      return { ...state, saveState: { phase: "saving" } };

    case "saved": {
      // The PUT succeeded, so the phase is `saved` regardless; the frame advances only if it is still the
      // one saved (an author who navigated away mid-save must not have that frame re-based).
      const top = state.frames[action.depth];
      if (!top || !openedResultOf(top) || top.path !== action.path) return { ...state, saveState: { phase: "saved" } };
      const frames = state.frames.slice();
      frames[action.depth] = withSavePoint(top, action.etag, action.savedBytes);
      return { ...state, frames, saveState: { phase: "saved" } };
    }

    case "newFileSaved": {
      const { depth, etag, savedBytes, relativePath } = action;
      const top = state.frames[depth];
      // The from-scratch match: still unwritten and path-less. Anything else means the frame was re-based.
      if (!top || !openedResultOf(top) || top.written || top.path !== null) return { ...state, saveState: { phase: "saved" } };
      const frames = state.frames.slice();
      // The child is now a saved frame that adopts the server path; drop its `refParent` — it is bound.
      frames[depth] = { ...withSavePoint(top, etag, savedBytes), path: relativePath, refParent: undefined };
      // Back-fill the parent node's `ref` (#391) from the path the child was actually saved to. The parent
      // buffer moves off its baseline, so it reads dirty — the author saves it like any edit. Skip silently
      // if the parent frame or its `workflow` node is gone, which leaves the child standing on its own.
      const link = top.refParent;
      const parent = link ? frames[link.depth] : undefined;
      const parentResult = openedResultOf(parent);
      if (link && parent && parentResult && parent.path !== null) {
        const node = findById(parentResult.file.body, link.nodeId);
        if (node && node.type === "workflow") {
          const ref = relativeRefPath(parent.path, relativePath);
          const nextParent = replaceNode(parentResult.file, link.nodeId, { ...node, ref } as WorkflowNode);
          frames[link.depth] = { ...parent, state: { phase: "open", result: { ...parentResult, file: nextParent } } };
        }
      }
      return { ...state, frames, saveState: { phase: "saved" } };
    }

    case "setSaveState":
      return { ...state, saveState: action.saveState };
  }
}
