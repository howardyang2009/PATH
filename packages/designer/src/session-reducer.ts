import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import type { EditKey } from "./edit-key.js";
import { sameEditKey } from "./edit-key.js";
import type { OpenResult } from "./open-workflow.js";
import { editFile, findById, unwrapEdit } from "./edit-tree.js";
import { basename, relativeRefPath, resolveRefPath } from "./resolve-ref.js";
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
  /**
   * The fetch this frame is waiting on, as the monotonic number the hook minted for it — `null` when the
   * frame is not loading. `loadLanded` patches in **only** when the frame still holds this exact number,
   * which is the whole staleness verdict: the author may have descended, popped or re-opened while the
   * fetch was in flight, and a frame that moved on no longer holds the number.
   *
   * The hook supplies the number because only it knows a request was made; the **decision** it feeds
   * (is this result still the one we want?) is here, in the reducer, beside the trail it depends on —
   * rather than as a wall-clock pre-gate in the hook that the reducer then re-checked.
   */
  loadSeq: number | null;
  /**
   * The template this frame edits in **author mode** (#580, ADR 0049 decision 8): set when the author
   * opened a `*.step-template.json` itself, `undefined` for a workflow file. The suffix of the opened
   * file is the discriminator. A template frame is `written` (it is on disk) but holds no `path`: a
   * template is id-addressed (ADR 0050), so it takes no lease, cannot launch, and saves through
   * `PUT /v0/templates/:id` rather than the workflow write door.
   */
  template?: TemplateSource;
}

/** The file suffix a template carries on disk: `*.step-template.json`, one kind only (ADR 0063). */
export function templateSuffix(_kind: TemplateSource["kind"]): string {
  return ".step-template.json";
}

/** The template an author-mode frame edits: its id (the route key), kind, file stem, and origin. */
export interface TemplateSource {
  id: string;
  /**
   * Always `step` (ADR 0063): the frame's file is a synthetic workflow around the template's body;
   * only `body` goes back into the envelope on save.
   */
  kind: "step";
  /** The file stem — the template's name, immutable through the write-back door. */
  name: string;
  /** The template's description, kept so a template write-back rebuilds its envelope. */
  description: string;
  /** A shipped template: the write-back `PUT` answers `403`, so only the two Save-As doors work. */
  readOnly: boolean;
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
   * The identity of the in-progress field-edit run (`edit-key.ts`), or `undefined` when the last commit
   * closed a run. A field edit whose identity matches this folds into the current entry; any other
   * identity, or a structural edit, opens one.
   */
  coalesceKey: EditKey | undefined;
}

/**
 * The state of the active frame's save (#371, ADR 0016) — a transient UI phase, not the dirty relation:
 * `saved` shows the confirmation after a `200`; `conflict` is the `412` stale-write; `error` is any other
 * write failure. A Delete of the open file rides the same phase: `deleting` while in flight, `deleted`
 * once the file is gone (the canvas is then empty), `delete-error` when the server refused it.
 * `saved-as-template` confirms a workflow-mode Save as template: a copy was created, the workflow stays open.
 */
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
 * The default `name` a from-scratch buffer opens with (#390). It slugs cleanly to a filename
 * (`^[a-z][a-z0-9-]*$`), so the first-save dialog can prefill `untitled.workflow.json`.
 */
const NEW_FILE_DEFAULT_NAME = "untitled";

/**
 * A fresh loading frame for `path`: no ETag, an empty save-point, and an empty history until it opens.
 * `descendedVia` carries the parent `workflow` block id through the load (a descent) and through a reload,
 * so the breadcrumb's run badge survives the frame's fetch; `undefined` for a root open. `loadSeq` is the
 * fetch this frame awaits — see {@link Frame.loadSeq}.
 */
export function loadingFrame(path: string | null, descendedVia: string | undefined, loadSeq: number, template?: TemplateSource): Frame {
  // It targets an on-disk file, so it is `written`; the lease/launch gates read `openedResultOf` too, so
  // a still-loading frame is not yet leased regardless. A template frame has no path, only its `template`.
  return { path, written: true, state: { phase: "loading" }, etag: null, baseline: "", openedBytes: "", history: freshHistory(), descendedVia, loadSeq, template };
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
    // A from-scratch buffer fetches nothing, so no in-flight result can ever answer for it.
    loadSeq: null,
  };
}

/**
 * The default workflow `name` for a create-new child, taken from its filename stem. It falls back to the
 * from-scratch default when a stem does not slug to a legal name (`^[a-z][a-z0-9-]*$`).
 */
export function stemName(path: string): string {
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

/**
 * Would discarding this frame lose work? A frame dirty by {@link frameDirty}, except a from-scratch buffer
 * still exactly as it opened: it reads dirty only to keep Save live, and holds nothing the author made.
 */
export function frameHasUnsavedWork(frame: Frame | undefined): boolean {
  if (!frameDirty(frame)) return false;
  return frame!.written || canonicalSerialize(openedResultOf(frame)!.file) !== frame!.openedBytes;
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
/**
 * The Designer's edit mode, picked with the toolbar's Workflow | Template switch. **Workflow** mode edits
 * `*.workflow.json` files; **Template** mode edits template sources (`*.step-template.json`) and
 * new, not-yet-saved templates. Switching mode clears the canvas.
 */
export type EditMode = "workflow" | "template";

export interface SessionState {
  /** Which kind of file the session edits (see {@link EditMode}). */
  mode: EditMode;
  /** The navigation **trail**, root file first (#367). The active frame is `frames[activeIndex]`, not the tip. */
  frames: Frame[];
  /** The index of the active frame in `frames` — what the canvas renders and every edit/save op targets. */
  activeIndex: number;
  /** The active frame's save state — drives the save button and the stale-write conflict banner. */
  saveState: SaveState;
}

/** The empty session before any file opens. */
export const initialSessionState: SessionState = { mode: "workflow", frames: [], activeIndex: 0, saveState: { phase: "idle" } };

/**
 * Every transition the session makes. The reducer owns each **decision** — whether a descent re-enters
 * the frame ahead or loads fresh, whether a reload applies at all, whether a landed fetch is still the
 * one wanted, which save door the active frame takes ({@link planSave}) — and the hook performs the I/O
 * those decisions call for: it dispatches the synchronous action, reads the state it produced, and
 * fetches when that state asks for a fetch. `loadSeq` is the request's own number, minted by the hook
 * because only it knows a request was made; the verdict on it is here.
 */
export type SessionAction =
  /** Open `path` as a fresh root, discarding any current stack — one loading frame, active index 0. */
  | { type: "openLoading"; path: string; loadSeq: number }
  /**
   * Open a `*.step-template.json` itself as a fresh root in **author mode** (#580), discarding any
   * current stack — one loading template frame. Its read lands through `loadLanded` with a `null` path.
   */
  | { type: "openTemplateLoading"; template: TemplateSource; loadSeq: number }
  /** Start a from-scratch buffer as a fresh root (#390), discarding any current stack. */
  | { type: "newFile" }
  /**
   * Start a new, unsaved template in template mode, discarding any current stack: an empty buffer with no
   * template yet. Its kind and name are picked at its first save.
   */
  | { type: "newTemplate" }
  /** Switch the edit mode, discarding any current stack: the canvas is empty in the new mode. */
  | { type: "switchMode"; mode: EditMode }
  /**
   * Descend across the active file's `workflow`-ref. The reducer decides the whole shape of it: the
   * target path resolves from the active frame's own path, a frame just ahead that already holds it is
   * **re-entered** (a live, possibly-dirty child is not reloaded out from under the author), and
   * anything else truncates the forward trail and pushes a loading frame (#367). A frame with no path
   * (a from-scratch root) has no ref to resolve, so the action is a no-op.
   */
  | { type: "descend"; ref: string; nodeId: string; loadSeq: number }
  /** Descend into a fresh, unwritten, path-less create-new child linked back to `parentNodeId` (#391). */
  | { type: "descendNewUnbound"; parentNodeId: string }
  /** Make the breadcrumb entry at `index` active — an ascend or a forward re-entry; no frame is discarded. */
  | { type: "goTo"; index: number }
  /** Commit an edit to the active frame's opened file, folding a run of field edits that share an identity (#389). */
  | { type: "applyEdit"; next: WorkflowFile; key?: EditKey }
  /** Undo the active frame's last edit (#389). A no-op when its past stack is empty. */
  | { type: "undo" }
  /** Redo the active frame's last undo (#389). A no-op when its future stack is empty. */
  | { type: "redo" }
  /**
   * Re-fetch the active frame from disk, discarding its buffer for the on-disk bytes (#371). The reducer
   * decides whether anything is reloadable — an unwritten buffer has no on-disk bytes, and a fetch for a
   * 404 would throw the authored buffer away — so the hook only fetches when the state asks.
   */
  | { type: "reload"; loadSeq: number }
  /**
   * A file fetch-and-open landed. Patched in **only** when the frame at `depth` still awaits `loadSeq` —
   * the pure staleness guard that drops a result whose destination the author already left (or replaced).
   */
  | { type: "loadLanded"; depth: number; path: string | null; loadSeq: number; frameState: FrameState; etag: string | null; baseline: string; openedBytes: string }
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
  /**
   * An author-mode write-back succeeded (#580): advance the save-point of the frame at `depth`, guarded on
   * it still editing template `id`. Always sets the `saved` phase.
   */
  | { type: "templateSaved"; depth: number; id: string; etag: string; savedBytes: string }
  /**
   * An author-mode Save-As created a new template (#580): the frame at `depth`, if it still edits
   * `fromId`, now edits the new `template` and its `file` (the fresh workflow id), clean at `etag`. The
   * history starts fresh — an undo past the Save-As would restore the old template's id.
   */
  | { type: "templateSavedAs"; depth: number; fromId: string | null; template: TemplateSource; file: WorkflowFile; etag: string }
  /**
   * A workflow-mode Save as… wrote a copy to a new `*.workflow.json` at `relativePath`. If the frame at
   * `depth` still edits the file with id `fromId`, the session becomes that saved file as a fresh root,
   * the way a Save-As moves the editor onto the file it wrote. Always sets the `saved` phase.
   */
  | { type: "detachedSaved"; depth: number; fromId: string; file: WorkflowFile; relativePath: string; etag: string }
  /**
   * The root file named by `plan` was deleted. If the root frame still holds it, the stack clears to an
   * empty canvas in the same mode, in the `deleted` phase; otherwise only the phase resets.
   */
  | { type: "deleted"; plan: DeletePlan }
  /** Set the transient save phase directly — a failure mapping (`conflict`/`error`) or a reset to `idle`. */
  | { type: "setSaveState"; saveState: SaveState };

const IDLE: SaveState = { phase: "idle" };

/** The one pure `(state, action) => state` behind the whole session (see the module header). */
export function reduceSession(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "openLoading":
      return { mode: "workflow", frames: [loadingFrame(action.path, undefined, action.loadSeq)], activeIndex: 0, saveState: IDLE };

    case "newFile":
      return { mode: "workflow", frames: [scratchFrame()], activeIndex: 0, saveState: IDLE };

    case "newTemplate":
      return { mode: "template", frames: [scratchFrame()], activeIndex: 0, saveState: IDLE };

    case "switchMode":
      return { mode: action.mode, frames: [], activeIndex: 0, saveState: IDLE };

    case "deleted": {
      const root = state.frames[0];
      const plan = action.plan;
      const stillOpen = plan.kind === "template" ? root?.template?.id === plan.id : root?.path === plan.path && !root.template;
      if (!stillOpen) return { ...state, saveState: IDLE };
      return { mode: state.mode, frames: [], activeIndex: 0, saveState: { phase: "deleted" } };
    }

    case "openTemplateLoading":
      return { mode: "template", frames: [loadingFrame(null, undefined, action.loadSeq, action.template)], activeIndex: 0, saveState: IDLE };

    case "descend": {
      const depth = state.activeIndex;
      const active = state.frames[depth];
      // No active frame, or a from-scratch one with no path: there is no file to resolve the ref against.
      if (!active || active.path === null) return state;
      const path = resolveRefPath(active.path, action.ref);
      // Re-entry down the same trail: the frame just ahead already holds this target, so re-enter it —
      // the author returns to its live buffer (a dirty descended child is not reloaded out from under
      // them), and the reused frame keeps the `descendedVia` it was first loaded with.
      const ahead = state.frames[depth + 1];
      if (ahead && ahead.path === path) {
        return { ...state, activeIndex: depth + 1, saveState: IDLE };
      }
      // Otherwise truncate the forward trail and load the target fresh below the active frame. `nodeId`
      // is the `workflow` block crossed, kept on the child frame for the breadcrumb's run badge (#372).
      return {
        mode: state.mode,
        frames: [...state.frames.slice(0, depth + 1), loadingFrame(path, action.nodeId, action.loadSeq)],
        activeIndex: depth + 1,
        saveState: IDLE,
      };
    }

    case "descendNewUnbound": {
      const depth = state.activeIndex;
      if (!state.frames[depth]) return state;
      const childDepth = depth + 1;
      const child = scratchFrame(null, { depth, nodeId: action.parentNodeId });
      return { mode: state.mode, frames: [...state.frames.slice(0, childDepth), child], activeIndex: childDepth, saveState: IDLE };
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
      // Record an undo entry (#389). A field edit whose identity matches the run in progress **folds** —
      // the present buffer is the run's intermediate, dropped so undo jumps to where the run began. Any
      // other identity, or a structural edit (none), pushes the present as a new entry. Either way redo
      // is cleared. The identity is a value (`edit-key.ts`), compared structurally — the pane cannot
      // collide two fields into one entry by minting the same string for both.
      const fold = action.key !== undefined && sameEditKey(action.key, frame.history.coalesceKey);
      const past = fold ? frame.history.past : [...frame.history.past, opened.file];
      const frames = state.frames.slice();
      frames[depth] = {
        ...frame,
        state: { phase: "open", result: { ...opened, file: action.next } },
        history: { past, future: [], coalesceKey: action.key },
      };
      return { mode: state.mode, frames, activeIndex: depth, saveState: IDLE };
    }

    case "undo": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      // Nothing to undo is a true no-op: returning `state` keeps a standing "Saved"/conflict phase, which
      // the hook used to guarantee by pre-checking the stack before dispatching.
      if (!frame || !opened || frame.history.past.length === 0) return state;
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
      return { mode: state.mode, frames, activeIndex: depth, saveState: IDLE };
    }

    case "redo": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened || frame.history.future.length === 0) return state;
      const future = frame.history.future.slice();
      const restored = future.shift()!;
      const frames = state.frames.slice();
      frames[depth] = {
        ...frame,
        state: { phase: "open", result: { ...opened, file: restored } },
        history: { past: [...frame.history.past, opened.file], future, coalesceKey: undefined },
      };
      return { mode: state.mode, frames, activeIndex: depth, saveState: IDLE };
    }

    case "reload": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      // An unwritten buffer (a from-scratch root, or a create-new child) has no on-disk bytes to
      // re-fetch — reload is a no-op for it, and would discard the authored buffer for a 404. A template
      // frame has no path but is on disk, so it re-reads by its template id.
      if (!frame || !frame.written || (frame.path === null && !frame.template)) return state;
      const frames = state.frames.slice();
      // A reload keeps the frame's descent origin, so a re-fetched child still badges its run status.
      frames[depth] = loadingFrame(frame.path, frame.descendedVia, action.loadSeq, frame.template);
      return { ...state, frames, saveState: IDLE };
    }

    case "loadLanded": {
      const { depth, loadSeq } = action;
      // The pure staleness guard: patch in only when the frame at `depth` still awaits this exact fetch.
      // A frame the author left, replaced, or that has already landed holds a different number (a landed
      // or from-scratch frame holds `null`), so its result is dropped rather than patched over newer state.
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
        // Carry the descent origin across the fetch, so the opened child keeps its breadcrumb run badge,
        // and the template an author-mode read was for.
        descendedVia: frames[depth]?.descendedVia,
        loadSeq: null,
        template: frames[depth]?.template,
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
          const nextParent = unwrapEdit(editFile(parentResult.file, { kind: "replace", id: link.nodeId, node: { ...node, ref } as WorkflowNode }));
          frames[link.depth] = { ...parent, state: { phase: "open", result: { ...parentResult, file: nextParent } } };
        }
      }
      return { ...state, frames, saveState: { phase: "saved" } };
    }

    case "templateSaved": {
      const top = state.frames[action.depth];
      if (!top || !openedResultOf(top) || top.template?.id !== action.id) return { ...state, saveState: { phase: "saved" } };
      const frames = state.frames.slice();
      frames[action.depth] = withSavePoint(top, action.etag, action.savedBytes);
      return { ...state, frames, saveState: { phase: "saved" } };
    }

    case "templateSavedAs": {
      const top = state.frames[action.depth];
      const opened = openedResultOf(top);
      // `fromId: null` is a new template's first save: the frame held no template yet.
      if (!top || !opened || (top.template?.id ?? null) !== action.fromId) return { ...state, saveState: { phase: "saved" } };
      const bytes = canonicalSerialize(action.file);
      const frames = state.frames.slice();
      frames[action.depth] = {
        ...top,
        written: true,
        template: action.template,
        state: { phase: "open", result: { ...opened, file: action.file } },
        etag: action.etag,
        baseline: bytes,
        openedBytes: bytes,
        history: freshHistory(),
      };
      return { ...state, frames, saveState: { phase: "saved" } };
    }

    case "detachedSaved": {
      const top = state.frames[action.depth];
      const opened = openedResultOf(top);
      if (!top || !opened || opened.file.id !== action.fromId) return { ...state, saveState: { phase: "saved" } };
      const bytes = canonicalSerialize(action.file);
      const saved: Frame = {
        path: action.relativePath,
        written: true,
        state: { phase: "open", result: { status: "opened", file: action.file, idsStamped: false } },
        etag: action.etag,
        baseline: bytes,
        openedBytes: bytes,
        history: freshHistory(),
        loadSeq: null,
      };
      return { mode: "workflow", frames: [saved], activeIndex: 0, saveState: { phase: "saved" } };
    }

    case "setSaveState":
      return { ...state, saveState: action.saveState };
  }
}

// ── The save doors, as decisions the hook performs ──────────────────────────────────────────────────

/**
 * What the Save button would do with the active frame, or `null` when it does nothing. The door is the
 * session's own choice, kept here beside the frame fields it reads rather than re-derived in the hook:
 *
 * - **overwrite** — a written file saves under its `If-Match` ETag (ADR 0016);
 * - **create** — an unwritten create-new child creates **exclusively** at its pre-assigned path (ADR
 *   0016), so the server refuses an existing path rather than clobbering it.
 *
 * - **template** — an author-mode frame writes back to its own template by id (`PUT /v0/templates/:id`,
 *   #580) under the read's `If-Match`; a shipped template answers `403`.
 *
 * A from-scratch **root** (unwritten, no path) is `null`: it picks its path in the first-save dialog,
 * which is {@link planNewFileSave}. The `412` each door earns differs for the same reason: an overwrite
 * is a stale-write **conflict** to reload from, a create is a path **collision** to retarget.
 */
export type SavePlan =
  | { kind: "overwrite"; depth: number; path: string; file: WorkflowFile; ifMatch: string | undefined }
  | { kind: "create"; depth: number; path: string; file: WorkflowFile; ifMatch: undefined }
  | { kind: "template"; depth: number; id: string; template: TemplateSource; file: WorkflowFile; ifMatch: string };

export function planSave(state: SessionState): SavePlan | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  if (frame?.template && opened) {
    // The read always carries an ETag; an empty token would only earn the honest `412`.
    return { kind: "template", depth, id: frame.template.id, template: frame.template, file: opened.file, ifMatch: frame.etag ?? "" };
  }
  if (!frame || !opened || frame.path === null) return null;
  return frame.written
    ? { kind: "overwrite", depth, path: frame.path, file: opened.file, ifMatch: frame.etag ?? undefined }
    : { kind: "create", depth, path: frame.path, file: opened.file, ifMatch: undefined };
}

/**
 * What the Delete button would remove, or `null` when it does nothing. Delete acts on the **root** file
 * only (the breadcrumb's first entry, while it is active), so a nested file is deleted by opening it:
 *
 * - **workflow** — a written file removed through `DELETE /v0/workflows/file` under the read's `If-Match`
 *   ETag, so it never removes bytes the author has not seen (a refused file can be deleted too);
 * - **template** — a user template removed through `DELETE /v0/templates/:id`. A shipped template is
 *   read-only, so it has no plan.
 *
 * A new buffer that was never saved has nothing on disk, so it has no plan either.
 */
export type DeletePlan = { kind: "workflow"; path: string; ifMatch: string } | { kind: "template"; id: string; name: string };

export function planDelete(state: SessionState): DeletePlan | null {
  if (state.activeIndex !== 0) return null;
  const frame = state.frames[0];
  if (!frame || frame.state.phase !== "open") return null;
  if (frame.template) return frame.template.readOnly ? null : { kind: "template", id: frame.template.id, name: frame.template.name };
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
  // Only a from-scratch **root** buffer (unwritten, no path) picks its path in the dialog; a create-new
  // child (unwritten, path pre-assigned) and a saved frame both go through `planSave`.
  if (!frame || !opened || frame.written || frame.path !== null) return null;
  return { depth, file: opened.file };
}

/**
 * What the two author-mode Save-As doors (#580) start from: the active template frame's buffer and the
 * template it came from, or `null` when the active frame is not an opened template source. Save-As
 * template and Save-as-workflow each derive their own new identity from `file`.
 */
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
 * What a new template's first save starts from: the active buffer in template mode that holds no
 * template yet, or `null`. The save dialog picks its kind and name.
 */
export function planNewTemplateSave(state: SessionState): NewFileSavePlan | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  if (state.mode !== "template" || !frame || frame.template || !opened) return null;
  return { depth, file: opened.file };
}
