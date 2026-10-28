import { type Dialog, NO_DIALOG, openSaveAs } from "./dialog-flow.js";
import { planWrite } from "./session/save-plan.js";
import type { EditMode, PlanState } from "./session-reducer.js";

/** Which save gesture the toolbar, ⌘S or the menu fired. */
export type SaveGoal = "save" | "save-as";

/**
 * The one dialog a save gesture opens, read from the write plan (for a save) or the edit mode (for
 * a Save as…). No dialog means the gesture writes in place — or, for a Save as… outside a document,
 * does nothing.
 */
export function saveDialog(goal: SaveGoal, state: PlanState, mode: EditMode): Dialog {
  if (goal === "save-as") {
    return openSaveAs(
      mode === "template" ? { kind: "template-copy" } : { kind: "workflow-choice" },
    );
  }
  const plan = planWrite(state, { kind: "save" });
  if (plan.ok) return NO_DIALOG;
  switch (plan.reason) {
    case "needs-template-name":
      return openSaveAs({ kind: "new-template" });
    case "needs-workflow-path":
      return { kind: "new-file" };
    case "nothing-open":
      return NO_DIALOG;
  }
}

/** The three doors whose dialog collects a template's name, folder and description. */
export type TemplateSaveDoor =
  | { kind: "new-template" }
  | { kind: "template-copy" }
  | { kind: "workflow-as-template" };

/** The template save door a resolved dialog stands for; `null` for every other dialog. */
export function templateSaveDoor(dialog: Dialog): TemplateSaveDoor | null {
  if (dialog.kind !== "save-as") return null;
  switch (dialog.dialog.kind) {
    case "new-template":
      return { kind: "new-template" };
    case "template-copy":
      return { kind: "template-copy" };
    case "workflow-template":
      return { kind: "workflow-as-template" };
    case "workflow-choice":
    case "workflow-copy":
      return null;
  }
}
