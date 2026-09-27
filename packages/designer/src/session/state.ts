import type { WorkflowFile } from "@path/schema";
import type { EditKey } from "../edit-key.js";
import type { Frame, FrameState, SaveState, TemplateSource } from "./frame.js";
import type { DeletePlan } from "./save-plan.js";

// ── The session state and its actions ────────────────────────────────────────────────────────────

/** The Designer's edit mode, picked with the toolbar's Workflow | Template switch. Switching clears
 * the canvas. */
export type EditMode = "workflow" | "template";

export interface SessionState {
  mode: EditMode;
  /**
   * The next fetch token the reducer will mint (absent is 0). A read is stamped with one, so a
   * landing whose frame has moved on can be dropped; the counter lives here rather than in a frame
   * because a read replaces the whole trail.
   */
  loadToken?: number;
  /** The navigation **trail**, root file first. The active frame is `frames[activeIndex]`, not the
   * tip. */
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
 * Every transition the session makes. The reducer owns each **decision**; the hook performs the I/O
 * those call for.
 */
export type SessionAction =
  /** Open `path` as a fresh root, discarding any current stack — one loading frame, active index
   * 0. */
  | { type: "openLoading"; path: string }
  /** Open a `*.step-template.json` as author mode's root, discarding any current stack. */
  | { type: "openTemplateLoading"; template: TemplateSource }
  /** Start a from-scratch buffer as a fresh root, discarding any current stack. */
  | { type: "newFile" }
  /** Start a new, unsaved template in template mode, discarding any current stack. */
  | { type: "newTemplate" }
  /** Switch the edit mode, discarding any current stack: the canvas is empty in the new mode. */
  | { type: "switchMode"; mode: EditMode }
  /**
   * Descend across the active file's `workflow`-ref: re-enter a frame just ahead that already holds
   * the target (a live, possibly-dirty child is not reloaded out from under the author), otherwise
   * truncate the forward trail and push a loading frame. A path-less root has no ref to resolve, so
   * the action is a no-op.
   */
  | { type: "descend"; ref: string; nodeId: string }
  /** Descend into a fresh, unwritten, path-less create-new child linked back to `parentNodeId`. */
  | { type: "descendNewUnbound"; parentNodeId: string }
  /** Make the breadcrumb entry at `index` active — an ascend or a forward re-entry; no frame is
   * discarded. */
  | { type: "goTo"; index: number }
  /** Commit an edit to the active frame's opened file, folding a run of field edits that share an
   * identity. */
  | { type: "applyEdit"; next: WorkflowFile; key?: EditKey }
  /** Undo the active frame's last edit. A no-op when its past stack is empty. */
  | { type: "undo" }
  /** Redo the active frame's last undo. A no-op when its future stack is empty. */
  | { type: "redo" }
  /**
   * Re-fetch the active frame from disk; a no-op when nothing is reloadable (an unwritten buffer,
   * or a fetch that would discard the authored buffer).
   */
  | { type: "reload" }
  /** A file fetch-and-open landed. Patched in only when the frame at `depth` still awaits `token`
   * — the pure staleness guard that drops a result whose destination the author already left. */
  | {
      type: "loadLanded";
      depth: number;
      path: string | null;
      token: number;
      frameState: FrameState;
      etag: string | null;
      baseline: string;
      openedBytes: string;
    }
  /** A `PUT` is in flight — the transient `saving` phase. */
  | { type: "saveStarted" }
  /** A written file's save succeeded: advance its save-point, guarded on the frame at `depth` still
   * holding `path`. */
  | { type: "saved"; depth: number; path: string; etag: string; savedBytes: string }
  /**
   * A from-scratch root's first save succeeded: the frame adopts the server `relativePath`, drops
   * its `refParent`, and back-fills the parent's `ref`.
   */
  | { type: "newFileSaved"; depth: number; etag: string; savedBytes: string; relativePath: string }
  /** An author-mode write-back succeeded, guarded on the frame at `depth` still editing template
   * `id`. */
  | { type: "templateSaved"; depth: number; id: string; etag: string; savedBytes: string }
  /** An author-mode Save-As created a new template: the frame now edits it and its fresh file,
   * clean at `etag`. The history starts fresh — an undo past the Save-As would restore the old
   * template's id. */
  | {
      type: "templateSavedAs";
      depth: number;
      fromId: string | null;
      template: TemplateSource;
      file: WorkflowFile;
      etag: string;
    }
  /** A workflow-mode Save as… wrote a copy at `relativePath`: the session becomes that saved file
   * as a fresh root. */
  | {
      type: "detachedSaved";
      depth: number;
      fromId: string;
      file: WorkflowFile;
      relativePath: string;
      etag: string;
    }
  /** The root file named by `plan` was deleted: clear to an empty canvas if still open, else only
   * reset the phase. */
  | { type: "deleted"; plan: DeletePlan }
  /** Set the transient save phase directly. */
  | { type: "setSaveState"; saveState: SaveState };

/** The save state with nothing in flight and nothing to report. */
export const IDLE: SaveState = { phase: "idle" };
