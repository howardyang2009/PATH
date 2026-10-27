import type { TemplateSummary, WorkflowSummary } from "@path/client-core";
import { describe, expect, it } from "vitest";
import {
  type CheckedFile,
  checkUploadFile,
  planUpload,
  readUpload,
  type Upload,
  type UploadView,
} from "../src/upload.js";

/** Upload's checks and its write decision, before any request leaves the browser. */

describe("checkUploadFile", () => {
  it("takes the kind from the suffix", () => {
    expect(checkUploadFile({ name: "flow.workflow.json", size: 10 })).toEqual({
      ok: true,
      kind: "workflow",
      stem: "flow",
      fileName: "flow.workflow.json",
    });
    expect(checkUploadFile({ name: "gate.step-template.json", size: 10 })).toEqual({
      ok: true,
      kind: "template",
      stem: "gate",
      fileName: "gate.step-template.json",
    });
  });

  it("refuses another suffix", () => {
    expect(checkUploadFile({ name: "notes.json", size: 10 })).toEqual({
      ok: false,
      message: { key: "designer.upload.wrongSuffix", params: { name: "notes.json" } },
    });
  });

  it("refuses a file over 1 MB before it is read", () => {
    expect(checkUploadFile({ name: "big.workflow.json", size: 1024 * 1024 })).toMatchObject({
      ok: true,
    });
    expect(checkUploadFile({ name: "big.workflow.json", size: 1024 * 1024 + 1 })).toEqual({
      ok: false,
      message: { key: "designer.upload.tooLarge", params: { name: "big.workflow.json" } },
    });
  });

  it("refuses a template name that is not a plain lower-case name", () => {
    expect(checkUploadFile({ name: "My Gate.step-template.json", size: 10 })).toEqual({
      ok: false,
      message: { key: "designer.upload.badName", params: { name: "My Gate.step-template.json" } },
    });
  });

  it("keeps a workflow name as is, but refuses a dot-leading one", () => {
    expect(checkUploadFile({ name: "My Flow.workflow.json", size: 10 })).toMatchObject({
      ok: true,
      stem: "My Flow",
    });
    expect(checkUploadFile({ name: ".hidden.workflow.json", size: 10 })).toEqual({
      ok: false,
      message: { key: "designer.upload.badName", params: { name: ".hidden.workflow.json" } },
    });
  });
});

const WORKFLOW: CheckedFile = {
  ok: true,
  kind: "workflow",
  stem: "flow",
  fileName: "flow.workflow.json",
};
const TEMPLATE: CheckedFile = {
  ok: true,
  kind: "template",
  stem: "gate",
  fileName: "gate.step-template.json",
};
const WORKFLOW_ID = "44444444-5555-4555-8555-555555555555";
const TEMPLATE_ID = "11111111-5555-4555-8555-555555555555";
const WORKFLOW_FILE = { format: "path/workflow@6", id: WORKFLOW_ID, name: "flow", body: [] };
const TEMPLATE_FILE = { format: "path/workflow@6", id: TEMPLATE_ID, description: "d", body: [] };

describe("readUpload", () => {
  it("parses the file's content", () => {
    expect(readUpload(WORKFLOW, JSON.stringify(WORKFLOW_FILE))).toEqual({
      ok: true,
      upload: {
        kind: "workflow",
        stem: "flow",
        fileName: "flow.workflow.json",
        content: WORKFLOW_FILE,
        folder: "",
      },
    });
  });

  it("refuses text that is not a JSON object", () => {
    for (const text of ["{ nope", "[1]", "null"]) {
      expect(readUpload(WORKFLOW, text)).toEqual({
        ok: false,
        message: { key: "designer.upload.notJson", params: { name: "flow.workflow.json" } },
      });
    }
  });

  it("refuses content of the other kind", () => {
    expect(readUpload(WORKFLOW, JSON.stringify(TEMPLATE_FILE))).toEqual({
      ok: false,
      message: { key: "designer.upload.kindMismatch", params: { name: "flow.workflow.json" } },
    });
    expect(readUpload(TEMPLATE, JSON.stringify(WORKFLOW_FILE))).toEqual({
      ok: false,
      message: { key: "designer.upload.kindMismatch", params: { name: "gate.step-template.json" } },
    });
  });
});

const ROOTS = [
  { origin: "user" as const, relative_path: "users/local/workflow" },
  { origin: "shared" as const, relative_path: "shared/workflow" },
];
const OWN_PATH = "users/local/workflow/flow.workflow.json";

function workflowRow(relative_path: string, id: string): WorkflowSummary {
  const origin = relative_path.startsWith("users/") ? "user" : "shared";
  return {
    relative_path,
    origin,
    root_path: relative_path.split("/").pop() ?? "",
    action: "open",
    read_only: false,
    id,
    name: "flow",
    valid: true,
    is_root: true,
    error: null,
  };
}

function templateRow(
  name: string,
  id: string,
  origin: TemplateSummary["origin"] = "user",
  folder = "",
): TemplateSummary {
  return {
    id,
    name,
    description: "d",
    kind: "step",
    origin,
    folder,
    read_only: origin !== "user",
    valid: true,
    error: null,
  };
}

const workflowUpload: Upload = {
  kind: "workflow",
  stem: "flow",
  fileName: "flow.workflow.json",
  content: WORKFLOW_FILE,
  folder: "",
};
const templateUpload: Upload = {
  kind: "template",
  stem: "gate",
  fileName: "gate.step-template.json",
  content: TEMPLATE_FILE,
  folder: "",
};
const view = (over: Partial<UploadView>): UploadView => ({
  workflows: [],
  roots: ROOTS,
  templates: [],
  ...over,
});
const OTHER_ID = "99999999-5555-4555-8555-555555555555";

describe("planUpload", () => {
  it("creates a new workflow at the top of the user root", () => {
    expect(planUpload(workflowUpload, view({}))).toEqual({ action: "create", path: OWN_PATH });
  });

  it("creates a new workflow in the picked folder of the user root", () => {
    expect(planUpload({ ...workflowUpload, folder: "lib/drafts" }, view({}))).toEqual({
      action: "create",
      path: "users/local/workflow/lib/drafts/flow.workflow.json",
    });
  });

  it("refuses a workflow when the requester has no user root", () => {
    expect(planUpload(workflowUpload, view({ roots: [ROOTS[1]!] }))).toEqual({
      action: "refuse",
      message: { key: "designer.upload.noUserRoot" },
    });
  });

  it("replaces the own workflow of the same name and id", () => {
    const workflows = [workflowRow(OWN_PATH, WORKFLOW_ID)];
    expect(planUpload(workflowUpload, view({ workflows }))).toEqual({
      action: "replace",
      path: OWN_PATH,
    });
  });

  it("copies a workflow whose id another file holds", () => {
    const workflows = [workflowRow("shared/workflow/team.workflow.json", WORKFLOW_ID)];
    expect(planUpload(workflowUpload, view({ workflows }))).toEqual({ action: "copy" });
  });

  it("copies a workflow whose name an own file of another id holds", () => {
    const workflows = [workflowRow(OWN_PATH, OTHER_ID)];
    expect(planUpload(workflowUpload, view({ workflows }))).toEqual({ action: "copy" });
  });

  it("creates a new template", () => {
    expect(planUpload(templateUpload, view({}))).toEqual({ action: "create" });
  });

  it("replaces the own top-level template of the same name and id", () => {
    const templates = [templateRow("gate", TEMPLATE_ID)];
    expect(planUpload(templateUpload, view({ templates }))).toEqual({
      action: "replace",
      id: TEMPLATE_ID,
    });
  });

  it("replaces the own template of the same name and id in the picked folder", () => {
    const templates = [templateRow("gate", TEMPLATE_ID, "user", "lib")];
    expect(planUpload({ ...templateUpload, folder: "lib" }, view({ templates }))).toEqual({
      action: "replace",
      id: TEMPLATE_ID,
    });
  });

  it("copies a template whose id a shipped, shared or other own template holds", () => {
    for (const holder of [
      templateRow("gate", TEMPLATE_ID, "shipped"),
      templateRow("gate", TEMPLATE_ID, "shared"),
      templateRow("other", TEMPLATE_ID),
      templateRow("gate", TEMPLATE_ID, "user", "lib"),
    ]) {
      expect(planUpload(templateUpload, view({ templates: [holder] }))).toEqual({
        action: "copy",
      });
    }
  });

  it("copies a template whose name an own template of another id holds", () => {
    const templates = [templateRow("gate", OTHER_ID)];
    expect(planUpload(templateUpload, view({ templates }))).toEqual({ action: "copy" });
  });
});
