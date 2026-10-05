import { describe, expect, it } from "vitest";
import {
  type Dialog,
  type DialogView,
  dialogOnSave,
  NO_DIALOG,
  resolvedDialog,
  type SaveAsDialog,
  saveAsDialog,
} from "../src/dialog-flow.js";

const view = (overrides: Partial<DialogView> = {}): DialogView => ({
  mode: "workflow",
  hasOpenFile: true,
  activeTemplate: false,
  scratch: false,
  ...overrides,
});

const saveAs = (kind: SaveAsDialog["kind"]): Dialog => ({ kind: "save-as", dialog: { kind } });

describe("dialog-flow — which dialog may be open", () => {
  it("opens the mode's Save as… door", () => {
    expect(saveAsDialog("template")).toEqual(saveAs("template-copy"));
    expect(saveAsDialog("workflow")).toEqual(saveAs("workflow-choice"));
  });

  it("opens a first-save door only for a buffer that has no identity", () => {
    expect(dialogOnSave("new-template-dialog")).toEqual(saveAs("new-template"));
    expect(dialogOnSave("new-workflow-dialog")).toEqual({ kind: "new-file" });
    expect(dialogOnSave("save")).toEqual(NO_DIALOG);
    expect(dialogOnSave(null)).toEqual(NO_DIALOG);
  });

  it("closes a first-save dialog once the buffer has a path or a template source", () => {
    const open = { kind: "new-file" } as Dialog;
    expect(resolvedDialog(open, view({ scratch: true }))).toEqual(open);
    expect(resolvedDialog(open, view())).toEqual(NO_DIALOG);
    expect(resolvedDialog(open, view({ scratch: true, activeTemplate: true }))).toEqual(NO_DIALOG);
    expect(resolvedDialog(open, view({ scratch: true, hasOpenFile: false }))).toEqual(NO_DIALOG);
  });

  it("closes a Save as… door whose document moved on", () => {
    expect(resolvedDialog(saveAs("template-copy"), view({ activeTemplate: true }))).toEqual(
      saveAs("template-copy"),
    );
    expect(resolvedDialog(saveAs("template-copy"), view())).toEqual(NO_DIALOG);

    for (const kind of ["workflow-choice", "workflow-template", "workflow-copy"] as const) {
      expect(resolvedDialog(saveAs(kind), view())).toEqual(saveAs(kind));
      expect(resolvedDialog(saveAs(kind), view({ mode: "template" }))).toEqual(NO_DIALOG);
      expect(resolvedDialog(saveAs(kind), view({ hasOpenFile: false }))).toEqual(NO_DIALOG);
    }

    expect(
      resolvedDialog(saveAs("new-template"), view({ mode: "template", scratch: true })),
    ).toEqual(saveAs("new-template"));
    // The door's own eligibility is the write plan's; the flow only refuses it outside template mode.
    expect(resolvedDialog(saveAs("new-template"), view({ mode: "workflow" }))).toEqual(NO_DIALOG);
  });

  it("leaves the two whole-file pickers alone: their openers own the gate", () => {
    expect(resolvedDialog({ kind: "open-workflow" }, view())).toEqual({ kind: "open-workflow" });
    expect(resolvedDialog({ kind: "open-template" }, view())).toEqual({ kind: "open-template" });
    expect(resolvedDialog(NO_DIALOG, view())).toEqual(NO_DIALOG);
  });
});
