import type { PathApiClient, TemplateSummary } from "@path/client-core";
import { describe, expect, it } from "vitest";
import { type DoorContext, documentDoors } from "../src/document-doors.js";
import { type Frame, type SessionAction, scratchFrame } from "../src/session-reducer.js";

/**
 * The doors that replace the open stack, through their own interface: a fake client, a fake
 * session and scripted prompts, with no App.
 */

/** A frame with unsaved work: written, and its buffer differs from its (empty) baseline. */
const unsaved: Frame = { ...scratchFrame("flow.workflow.json"), written: true };

const template: TemplateSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "review",
  description: "d",
  kind: "step",
  origin: "shared",
  read_only: true,
  valid: true,
  error: null,
};

/** The doors over `frames`, recording every step they take, with the author answering `discard`. */
function doors(frames: Frame[], discard: boolean) {
  const steps: string[] = [];
  const context: DoorContext = {
    client: {
      copyShippedWorkflow: async (path: string) => {
        steps.push(`copy ${path}`);
        return { relativePath: `users/local/workflow/${path}`, rootPath: path };
      },
    } as unknown as PathApiClient,
    session: {
      frames,
      mode: "workflow",
      apply: (action: SessionAction) => steps.push(`apply ${action.type}`),
    },
    disarm: () => steps.push("disarm"),
    rescan: () => steps.push("rescan"),
    prompts: {
      discardUnsaved: () => {
        steps.push("ask");
        return discard;
      },
      replaceUpload: () => true,
      uploadRefused: () => steps.push("refused"),
    },
  };
  return { doors: documentDoors(context), steps };
}

describe("documentDoors", () => {
  it("opens without asking when no frame has unsaved work, disarming first", () => {
    const { doors: d, steps } = doors([scratchFrame()], false);
    d.openWorkflow("flow.workflow.json");
    expect(steps).toEqual(["disarm", "apply openLoading"]);
  });

  it("asks before every door replaces unsaved work, and does nothing on a refusal", async () => {
    const { doors: d, steps } = doors([unsaved], false);
    d.newDocument();
    d.switchMode("template");
    d.openWorkflow("flow.workflow.json");
    d.openTemplate(template);
    await d.copyShipped("notes/main.workflow.json");
    expect(steps).toEqual(["ask", "ask", "ask", "ask", "ask"]);
  });

  it("asks before it copies a shipped workflow, so a cancel writes nothing", async () => {
    const { doors: d, steps } = doors([unsaved], true);
    await d.copyShipped("notes/main.workflow.json");
    expect(steps).toEqual([
      "ask",
      "copy notes/main.workflow.json",
      "rescan",
      "disarm",
      "apply openLoading",
    ]);
  });

  it("opens a template source with its read-only reason, and leaves an id-less one shut", () => {
    const applied: SessionAction[] = [];
    const d = documentDoors({
      client: {} as PathApiClient,
      session: { frames: [], mode: "template", apply: (action) => applied.push(action) },
      disarm: () => {},
      rescan: () => {},
      prompts: { discardUnsaved: () => true, replaceUpload: () => true, uploadRefused: () => {} },
    });
    d.openTemplate({ ...template, id: null });
    d.openTemplate(template);
    expect(applied).toEqual([
      {
        type: "openTemplateLoading",
        template: {
          id: template.id,
          kind: "step",
          name: "review",
          description: "d",
          readOnly: "shared",
        },
      },
    ]);
  });

  it("opens what an upload wrote after a rescan, and only reports a refusal", () => {
    const { doors: d, steps } = doors([unsaved], false);
    d.openUploaded({ status: "refused", message: { key: "designer.upload.noUserRoot" } });
    d.openUploaded({ status: "done", target: { kind: "workflow", path: "up.workflow.json" } });
    // The author agreed to drop unsaved work when picking the file, so the open does not ask again.
    expect(steps).toEqual(["refused", "rescan", "disarm", "apply openLoading"]);
  });
});
