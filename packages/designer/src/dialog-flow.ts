import type { SaveDoor } from "./document.js";
import type { EditMode } from "./session-reducer.js";

/** The five **Save as…** doors: which copy a Save as… or a first save lands on. */
export type SaveAsDialog =
  /** A new template's first save: name, folder, origin, description. */
  | { kind: "new-template" }
  /** Save as… of an opened template source: a copy under a new name. */
  | { kind: "template-copy" }
  /** Workflow mode picks a copy of the file or a template made from its body. */
  | { kind: "workflow-choice" }
  /** The workflow's body as a new template. */
  | { kind: "workflow-template" }
  /** A copy of the workflow under a new path. */
  | { kind: "workflow-copy" };

/**
 * The one dialog the Designer has open, if any: a whole-file picker, or a Save as… door. Every
 * transition and precondition lives here, so a new dialog joins the union instead of spreading
 * another `useState` and its conditions through `App`.
 */
export type Dialog =
  | { kind: "none" }
  | { kind: "new-file" }
  | { kind: "open-workflow" }
  | { kind: "open-template" }
  | { kind: "save-as"; dialog: SaveAsDialog };

export const NO_DIALOG: Dialog = { kind: "none" };

/** What the flow reads off the session: the edit mode, and the active frame's three shapes. */
export interface DialogView {
  mode: EditMode;
  /** A file is open on the canvas. */
  hasOpenFile: boolean;
  /** The active frame is a `*.step-template.json` source (author mode). */
  activeTemplate: boolean;
  /** The active frame is a buffer with no path yet (a from-scratch workflow or template). */
  scratch: boolean;
}

/** The dialog the toolbar's Save as… opens, by edit mode: a template copy, or the workflow choice. */
export function saveAsDialog(mode: EditMode): Dialog {
  return openSaveAs(mode === "template" ? { kind: "template-copy" } : { kind: "workflow-choice" });
}

/** The Save as… dialog one chosen door opens (the workflow-choice step picks between two of these). */
export function openSaveAs(dialog: SaveAsDialog): Dialog {
  return { kind: "save-as", dialog };
}

/** The dialog a Save opens: a buffer with no identity takes its first-save door; a written one
 * saves in place (`none`). The door is the write plan's own answer (`documentPolicy`). */
export function dialogOnSave(door: SaveDoor | null): Dialog {
  if (door === "new-template-dialog") return openSaveAs({ kind: "new-template" });
  if (door === "new-workflow-dialog") return { kind: "new-file" };
  return NO_DIALOG;
}

/**
 * The dialog `dialog` may be, under `view`: a door whose document has moved on (the buffer got a
 * path, the template source closed, the mode switched) closes rather than rendering against a
 * frame it no longer describes.
 */
export function resolvedDialog(dialog: Dialog, view: DialogView): Dialog {
  switch (dialog.kind) {
    case "none":
    case "open-workflow":
    case "open-template":
      return dialog;
    case "new-file":
      return view.hasOpenFile && view.scratch && !view.activeTemplate ? dialog : NO_DIALOG;
    case "save-as":
      return saveAsResolves(dialog.dialog.kind, view) ? dialog : NO_DIALOG;
  }
}

function saveAsResolves(kind: SaveAsDialog["kind"], view: DialogView): boolean {
  switch (kind) {
    case "new-template":
      return view.mode === "template" && view.hasOpenFile && !view.activeTemplate;
    case "template-copy":
      return view.activeTemplate;
    case "workflow-choice":
    case "workflow-template":
    case "workflow-copy":
      return view.mode === "workflow" && view.hasOpenFile;
  }
}
