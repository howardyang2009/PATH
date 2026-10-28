import type { Message } from "@path/i18n";
import type { DocumentPolicy } from "./document.js";
import type { LeaseState } from "./lease-client.js";
import type { ReadOnlyReason } from "./read-only.js";
import { frameCanRedo, frameCanUndo, frameDirty, type SessionState } from "./session-reducer.js";

/** What the editing toolbar's controls read: which document actions are live, what Save shows, and
 * the active file's lease. One value, so the toolbar computes no enablement of its own. */
export interface EditorChrome {
  /** Save is live: not mid-write, not a `412` conflict, unsaved work, and a writable document. */
  save: boolean;
  /** The Save button's label while a write is in flight. */
  saveLabel: Message;
  /** A save or delete is in flight; the File menu's whole-file items wait for it. */
  busy: boolean;
  saveAs: boolean;
  undo: boolean;
  redo: boolean;
  /** Delete is live: a deletable root file, and a writable one. */
  remove: boolean;
  download: boolean;
  /** Why the document cannot be written, shown on a disabled Save and Delete; `false` when it can. */
  readOnly: ReadOnlyReason | false;
  lease: LeaseState | undefined;
}

/**
 * The editing toolbar's one capability value, derived in one place: the Save gate (ADR 0030's
 * content-equality dirty, ADR 0016's `412` conflict) and the document policy decide every button
 * the toolbar draws. The same gate serves the Save button, ⌘S and the File menu.
 */
export function editorChrome(
  session: SessionState,
  policy: Pick<DocumentPolicy, "canSaveAs" | "readOnly" | "deletePlan" | "downloadPlan">,
  lease: LeaseState | undefined,
): EditorChrome {
  const active = session.frames[session.activeIndex];
  const busy = session.saveState.phase === "saving" || session.saveState.phase === "deleting";
  return {
    save: !busy && session.saveState.phase !== "conflict" && frameDirty(active) && !policy.readOnly,
    saveLabel: {
      key:
        session.saveState.phase === "saving"
          ? "designer.editingToolbar.saving"
          : "designer.editingToolbar.save",
    },
    busy,
    saveAs: policy.canSaveAs,
    undo: frameCanUndo(active),
    redo: frameCanRedo(active),
    remove: policy.deletePlan !== null,
    download: policy.downloadPlan !== null,
    readOnly: policy.readOnly,
    lease,
  };
}
