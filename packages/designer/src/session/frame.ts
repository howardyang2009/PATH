import { FORMAT_VERSION, type WorkflowFile } from "@path/schema";
import type { EditKey } from "../edit-key.js";
import type { OpenResult } from "../open-workflow.js";
import { basename } from "../resolve-ref.js";
import { canonicalSerialize } from "../serialize.js";

/**
 * The Designer session's **pure state machine**: every open/descend/edit/undo/save-point transition
 * is a case of `reduceSession`, a pure `(state, action) => state`. The `useOpenFile` hook runs the
 * async I/O and dispatches the results, so no promise, no `client` and no wall-clock timing lives
 * here.
 */

// ── Frame types ──────────────────────────────────────────────────────────────────────────────────

/** One file on the navigation stack: its path, where its fetch-and-open got to, and its
 * save-point. */
export interface Frame {
  /** Project-relative path, or **`null`** for a from-scratch buffer until its first save. */
  path: string | null;
  /**
   * Has this buffer been **persisted to disk**? An unwritten frame takes no lease and cannot
   * launch, and its first save is an exclusive create (no `If-Match`, ADR 0016).
   */
  written: boolean;
  state: FrameState;
  /** The `If-Match` ETag for the next save; `null` when a proxy stripped the read route's `ETag`
   * header. */
  etag: string | null;
  /**
   * The on-disk bytes last synced (ADR 0030): the buffer is **clean** when
   * `canonicalSerialize(buffer) === baseline`. Advances only on a `200` save.
   */
  baseline: string;
  /** `canonicalSerialize(buffer)` at the last save-point; steers only the badge's wording, not
   * dirtiness. */
  openedBytes: string;
  /** This frame's own undo/redo stack; independent per open file and survives this frame's
   * saves. */
  history: History;
  /**
   * A create-new nested-ref child's back-link to the `workflow` node that spawned it; consumed at
   * the child's first save to back-fill the parent's `ref`.
   */
  refParent?: { depth: number; nodeId: string };
  /**
   * The parent frame's `workflow` block whose ref this frame descended through, so the breadcrumb
   * badges this crumb with the sub-workflow's run status.
   */
  descendedVia?: string;
  /**
   * The fetch this frame awaits, or `null` when idle. `loadLanded` patches in only while the number
   * still matches, which is the whole staleness verdict.
   */
  loadSeq: number | null;
  /**
   * The template this frame edits in author mode; a template frame is `written` but path-less, so
   * it takes no lease and saves by id (ADR 0050).
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

/** A frame is fetching, failed to fetch, or has an open outcome (which may itself be a legible
 * refusal). */
export type FrameState =
  | { phase: "loading" }
  | { phase: "fetch-error"; message: string }
  | { phase: "open"; result: OpenResult };

/** The undo/redo history of one frame: snapshots either side of the present buffer, which is not
 * held here. Per-frame, and survives a save, so undoing past the save-point re-dirties. Any new
 * edit clears redo. */
export interface History {
  past: WorkflowFile[];
  future: WorkflowFile[];
  /** Identity of the in-progress field-edit run; a matching field edit folds into the current
   * entry. */
  coalesceKey: EditKey | undefined;
}

/** The active frame's save phase (ADR 0016), a transient UI phase rather than the dirty relation. A
 * Delete rides the same phase; `saved-as-template` confirms a workflow-mode Save as template. */
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

/** A frame's opened workflow result, or `null` when it is loading, failed to fetch, or is a
 * refusal. */
export type OpenedResult = Extract<OpenResult, { status: "opened" }>;

// ── Frame helpers (pure) ─────────────────────────────────────────────────────────────────────────

/** A fresh, empty history — the state every frame opens (and re-opens, on a reload) with. */
export function freshHistory(): History {
  return { past: [], future: [], coalesceKey: undefined };
}

/**
 * The default `name` a from-scratch buffer opens with; it slugs cleanly so the first-save dialog
 * can prefill `untitled.workflow.json`.
 */
const NEW_FILE_DEFAULT_NAME = "untitled";

/** A fresh loading frame for `path`: no ETag, an empty save-point and history until it opens.
 * `descendedVia` carries the parent `workflow` block id through a descent or reload so the
 * breadcrumb run badge survives. */
export function loadingFrame(
  path: string | null,
  descendedVia: string | undefined,
  loadSeq: number,
  template?: TemplateSource,
): Frame {
  // It targets an on-disk file, so it is `written`; a still-loading frame is not yet leased
  // regardless.
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

/** A from-scratch buffer's frame: an empty, id-bearing **unwritten** workflow with no ETag and no
 * lease until its first save. `baseline` is `""`, so it reads dirty from open, which keeps Save
 * live. */
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
 * The default workflow `name` for a create-new child, from its filename stem (falling back when the
 * stem is not a legal name).
 */
export function stemName(path: string): string {
  const stem = basename(path).replace(/\.workflow\.json$/i, "");
  return /^[a-z][a-z0-9-]*$/.test(stem) ? stem : NEW_FILE_DEFAULT_NAME;
}

/** Advance a frame to a new **save-point** (ADR 0030): the written bytes become the baseline, the
 * fresh ETag the next `If-Match`, and `written` flips so a first-saved child acquires its lease and
 * launch enables. */
export function withSavePoint(frame: Frame, etag: string, savedBytes: string): Frame {
  return { ...frame, written: true, etag, baseline: savedBytes, openedBytes: savedBytes };
}

/** The frame's opened result, or `null`; the one predicate the canvas, the toolbar and the save
 * path all ask. */
export function openedResultOf(frame: Frame | undefined): OpenedResult | null {
  if (frame && frame.state.phase === "open" && frame.state.result.status === "opened")
    return frame.state.result;
  return null;
}

/** The one definition of **dirty** (ADR 0030): an opened frame's canonical serialization no longer
 * equals its `baseline`. Launch, the Save button and the dirty badge all read this, so the three
 * cannot drift. */
export function frameDirty(frame: Frame | undefined): boolean {
  const opened = openedResultOf(frame);
  if (!frame || !opened) return false;
  return canonicalSerialize(opened.file) !== frame.baseline;
}

/** Would discarding this frame lose work? Dirty, except a from-scratch buffer still exactly as it
 * opened (it reads dirty only to keep Save live, and holds nothing the author made). */
export function frameHasUnsavedWork(frame: Frame | undefined): boolean {
  const opened = openedResultOf(frame);
  if (!frame || !opened || !frameDirty(frame)) return false;
  return frame.written || canonicalSerialize(opened.file) !== frame.openedBytes;
}

/** Has the active frame an edit to undo? Drives the toolbar's Undo button and its keyboard peer. */
export function frameCanUndo(frame: Frame | undefined): boolean {
  return frame !== undefined && frame.history.past.length > 0;
}

/** Has the active frame an undo to redo? Drives the toolbar's Redo button and its keyboard peer. */
export function frameCanRedo(frame: Frame | undefined): boolean {
  return frame !== undefined && frame.history.future.length > 0;
}
