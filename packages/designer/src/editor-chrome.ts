import type { DocumentPolicy } from "./document.js";
import type { LeaseState } from "./lease-client.js";
import {
  type DeletePlan,
  type DownloadPlan,
  frameCanRedo,
  frameCanUndo,
  frameDirty,
  type SessionState,
} from "./session-reducer.js";

/** What the editing toolbar's controls read: which document actions are live, what Save shows, and
 * the active file's lease. One value, so the toolbar computes no enablement of its own. */
export interface EditorChrome {
  /** Save is live: not mid-write, not a `412` conflict, unsaved work, and a writable document. */
  save: boolean;
  /** The Save button's label while a write is in flight. */
  saveLabel: "Save" | "Saving…";
  /** A save or delete is in flight; the File menu's whole-file items wait for it. */
  busy: boolean;
  saveAs: boolean;
  undo: boolean;
  redo: boolean;
  /** Delete is live: a deletable root file, and a writable one. */
  remove: boolean;
  download: boolean;
  /** Why the document cannot be written, shown on a disabled Save and Delete. */
  readOnlyTitle?: string;
  lease: LeaseState | undefined;
}

/** The facts the chrome reads: the session holding the buffer and its history, the document policy,
 * the two file-action plans, and the active file's lease. */
export interface EditorChromeInput {
  session: SessionState;
  policy: Pick<DocumentPolicy, "canSaveAs">;
  deletePlan: DeletePlan | null;
  downloadPlan: DownloadPlan | null;
  readOnlyTitle: string | undefined;
  lease: LeaseState | undefined;
}

/**
 * The editing toolbar's one capability value, derived in one place: the Save gate (ADR 0030's
 * content-equality dirty, ADR 0016's `412` conflict) and the two plans decide every button the
 * toolbar draws. The same gate serves the Save button, ⌘S and the File menu.
 */
export function editorChrome({
  session,
  policy,
  deletePlan,
  downloadPlan,
  readOnlyTitle,
  lease,
}: EditorChromeInput): EditorChrome {
  const active = session.frames[session.activeIndex];
  const busy = session.saveState.phase === "saving" || session.saveState.phase === "deleting";
  return {
    save:
      !busy &&
      session.saveState.phase !== "conflict" &&
      frameDirty(active) &&
      readOnlyTitle === undefined,
    saveLabel: session.saveState.phase === "saving" ? "Saving…" : "Save",
    busy,
    saveAs: policy.canSaveAs,
    undo: frameCanUndo(active),
    redo: frameCanRedo(active),
    remove: deletePlan !== null && readOnlyTitle === undefined,
    download: downloadPlan !== null,
    ...(readOnlyTitle === undefined ? {} : { readOnlyTitle }),
    lease,
  };
}
