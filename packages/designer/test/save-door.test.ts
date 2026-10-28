import { describe, expect, it } from "vitest";
import { type Dialog, NO_DIALOG } from "../src/dialog-flow.js";
import { saveDialog, templateSaveDoor } from "../src/save-door.js";
import type { PlanState } from "../src/session/save-plan.js";
import { initialSessionState, reduceSession } from "../src/session-reducer.js";

const NOTHING_OPEN: PlanState = { mode: "workflow", frames: [], activeIndex: 0 };

const scratchWorkflow = reduceSession(initialSessionState, { type: "newFile" }).state;
const scratchTemplate = reduceSession(initialSessionState, { type: "newTemplate" }).state;

const saveAs = (dialog: Dialog & { kind: "save-as" }) => dialog;

describe("saveDialog — what a save gesture opens", () => {
  it("opens nothing while no document is open", () => {
    expect(saveDialog("save", NOTHING_OPEN, "workflow")).toEqual(NO_DIALOG);
  });

  it("opens the first-save dialog of a from-scratch buffer", () => {
    expect(saveDialog("save", scratchWorkflow, "workflow")).toEqual({ kind: "new-file" });
    expect(saveDialog("save", scratchTemplate, "template")).toEqual(
      saveAs({ kind: "save-as", dialog: { kind: "new-template" } }),
    );
  });

  it("opens Save as…'s mode door", () => {
    expect(saveDialog("save-as", NOTHING_OPEN, "template")).toEqual(
      saveAs({ kind: "save-as", dialog: { kind: "template-copy" } }),
    );
    expect(saveDialog("save-as", NOTHING_OPEN, "workflow")).toEqual(
      saveAs({ kind: "save-as", dialog: { kind: "workflow-choice" } }),
    );
  });
});

describe("templateSaveDoor — which template intent a resolved dialog stands for", () => {
  it("names the three template doors", () => {
    expect(templateSaveDoor({ kind: "save-as", dialog: { kind: "new-template" } })).toEqual({
      kind: "new-template",
    });
    expect(templateSaveDoor({ kind: "save-as", dialog: { kind: "template-copy" } })).toEqual({
      kind: "template-copy",
    });
    expect(templateSaveDoor({ kind: "save-as", dialog: { kind: "workflow-template" } })).toEqual({
      kind: "workflow-as-template",
    });
  });

  it("stands for no template when the dialog is another door", () => {
    expect(templateSaveDoor(NO_DIALOG)).toBeNull();
    expect(templateSaveDoor({ kind: "new-file" })).toBeNull();
    expect(templateSaveDoor({ kind: "save-as", dialog: { kind: "workflow-choice" } })).toBeNull();
    expect(templateSaveDoor({ kind: "save-as", dialog: { kind: "workflow-copy" } })).toBeNull();
  });
});
