import {
  apiErrorMessage,
  type PathApiClient,
  PathApiError,
  type WorkflowSummary,
} from "@path/client-core";
import { verbatim } from "@path/i18n";
import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { describe, expect, it } from "vitest";
import type { DiscoveryLoad } from "../src/discovery.js";
import {
  type DocumentWrite,
  documentPolicy,
  loadDocument,
  writeDocument,
} from "../src/document.js";
import { canonicalSerialize } from "../src/serialize.js";
import {
  type Frame,
  loadingFrame,
  type SessionState,
  scratchFrame,
  type TemplateSource,
} from "../src/session-reducer.js";

/**
 * The open document (`document.ts`) through its own interface: the session policy the toolbar and
 * the lease read, and the one write whose refusals read the same across both doors — with a fake
 * client and no App.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const file: WorkflowFile = {
  format: FORMAT_VERSION,
  id: uuid(1),
  name: "flow",
  body: [{ type: "prompt", id: uuid(2), name: "step", prompt: "" } as WorkflowNode],
};

function openFrame(overrides: Partial<Frame> = {}): Frame {
  const bytes = canonicalSerialize(file);
  return {
    path: "flow.workflow.json",
    written: true,
    state: { phase: "open", result: { status: "opened", file, idsStamped: false } },
    etag: "etag-open",
    baseline: bytes,
    openedBytes: bytes,
    history: { past: [], future: [], coalesceKey: undefined },
    loadSeq: null,
    ...overrides,
  };
}

const template: TemplateSource = {
  id: uuid(9),
  kind: "step",
  name: "review",
  description: "d",
  readOnly: false,
};

function session(
  frames: Frame[],
  mode: SessionState["mode"] = "workflow",
  activeIndex = frames.length - 1,
) {
  return { frames, activeIndex, mode };
}

/** A Discovery scan holding `rows`, each a writable user file unless it says otherwise. */
function discovery(rows: Partial<WorkflowSummary>[] = []): DiscoveryLoad {
  const workflows = rows.map((row) => ({
    relative_path: "flow.workflow.json",
    origin: "user" as const,
    root_path: "flow.workflow.json",
    action: "open" as const,
    read_only: false,
    id: uuid(1),
    name: "flow",
    valid: true,
    is_root: true,
    error: null,
    ...row,
  }));
  return { phase: "ready", scan: { workflows, roots: [], maxFileBytes: null } };
}

const NOT_SCANNED: DiscoveryLoad = { phase: "loading" };

describe("documentPolicy", () => {
  it("saves a written workflow in place, leases its path, and offers Delete and Download", () => {
    expect(documentPolicy(session([openFrame()]), NOT_SCANNED)).toEqual({
      saveDoor: "save",
      canSaveAs: true,
      readOnly: false,
      deletePlan: { kind: "workflow", path: "flow.workflow.json", ifMatch: "etag-open" },
      downloadPlan: { kind: "workflow", path: "flow.workflow.json" },
      leasedPaths: ["flow.workflow.json"],
    });
  });

  it("opens the first-save dialog of the mode for a from-scratch buffer, with no Save as… and no lease", () => {
    expect(documentPolicy(session([scratchFrame()]), NOT_SCANNED)).toEqual({
      saveDoor: "new-workflow-dialog",
      canSaveAs: false,
      readOnly: false,
      deletePlan: null,
      downloadPlan: null,
      leasedPaths: [],
    });
    expect(documentPolicy(session([scratchFrame()], "template"), NOT_SCANNED)).toMatchObject({
      saveDoor: "new-template-dialog",
    });
  });

  it("saves a template source in place by id, with no lease", () => {
    expect(
      documentPolicy(session([openFrame({ path: null, template })], "template"), NOT_SCANNED),
    ).toMatchObject({
      saveDoor: "save",
      canSaveAs: true,
      readOnly: false,
      deletePlan: { kind: "template", id: template.id },
      leasedPaths: [],
    });
  });

  it("saves a create-new child at its path but leases only written frames on the stack", () => {
    const child = scratchFrame("child.workflow.json", { depth: 0, nodeId: uuid(2) });
    expect(documentPolicy(session([openFrame(), child]), NOT_SCANNED)).toMatchObject({
      saveDoor: "save",
      canSaveAs: true,
      leasedPaths: ["flow.workflow.json"],
    });
  });

  it("offers nothing while the active frame is still loading", () => {
    expect(
      documentPolicy(session([loadingFrame("flow.workflow.json", undefined, 1)]), NOT_SCANNED),
    ).toEqual({
      saveDoor: null,
      canSaveAs: false,
      readOnly: false,
      deletePlan: null,
      downloadPlan: null,
      leasedPaths: [],
    });
  });

  it("reads a workflow's read-only reason off its Discovery row: no lease, no Delete", () => {
    const shared = discovery([{ origin: "shared", read_only: true }]);
    expect(documentPolicy(session([openFrame()]), shared)).toMatchObject({
      readOnly: "shared",
      deletePlan: null,
      downloadPlan: { kind: "workflow", path: "flow.workflow.json" },
      leasedPaths: [],
    });
    expect(documentPolicy(session([openFrame()]), discovery([{}]))).toMatchObject({
      readOnly: false,
      leasedPaths: ["flow.workflow.json"],
    });
  });

  it("reads a template's read-only reason off its frame", () => {
    const shipped = { ...template, readOnly: "shipped" as const };
    expect(
      documentPolicy(
        session([openFrame({ path: null, template: shipped })], "template"),
        NOT_SCANNED,
      ),
    ).toMatchObject({ readOnly: "shipped", deletePlan: null, saveDoor: "save" });
  });
});

/** A client whose three write calls resolve, or reject with `error`, recording what they were
 * sent. */
function fakeClient(error?: Error) {
  const calls: { method: string; input: unknown }[] = [];
  const answer = (method: string) => async (input: unknown) => {
    calls.push({ method, input });
    if (error) throw error;
    return { etag: '"new"', relativePath: "out.workflow.json", id: uuid(3) };
  };
  const client = {
    putWorkflow: answer("putWorkflow"),
    putTemplate: answer("putTemplate"),
    createTemplate: answer("createTemplate"),
  } as unknown as PathApiClient;
  return { client, calls };
}

describe("writeDocument", () => {
  const overwrite: DocumentWrite = {
    to: "workflow",
    path: "flow.workflow.json",
    ifMatch: '"old"',
    file,
  };
  const create: DocumentWrite = {
    to: "workflow",
    path: "flow.workflow.json",
    ifMatch: undefined,
    file,
  };
  const templatePut: DocumentWrite = {
    to: "template",
    id: template.id,
    ifMatch: '"old"',
    description: "d",
    file,
  };
  const templatePost: DocumentWrite = {
    to: "new-template",
    name: "review",
    description: "d",
    file,
  };

  it("echoes the written document", async () => {
    const { client, calls } = fakeClient();
    expect(await writeDocument(client, overwrite)).toEqual({
      ok: true,
      etag: '"new"',
      relativePath: "out.workflow.json",
      id: uuid(3),
    });
    expect(calls[0]).toMatchObject({
      method: "putWorkflow",
      input: { workflowPath: "flow.workflow.json", ifMatch: '"old"' },
    });
  });

  it("wraps a template's body in its envelope", async () => {
    const { client, calls } = fakeClient();
    await writeDocument(client, templatePost);
    expect(calls[0]).toMatchObject({
      method: "createTemplate",
      input: {
        kind: "step",
        name: "review",
        description: "d",
        body: { format: FORMAT_VERSION, id: file.id, description: "d", body: file.body },
      },
    });
  });

  const refusal = (status: number, code: string): PathApiError =>
    new PathApiError(status, code, undefined, code);

  it("reads an overwrite's changed precondition as stale on both doors", async () => {
    const { client } = fakeClient(refusal(412, "file.precondition.changed"));
    expect(await writeDocument(client, overwrite)).toMatchObject({ ok: false, conflict: "stale" });
    expect(await writeDocument(client, templatePut)).toMatchObject({
      ok: false,
      conflict: "stale",
    });
  });

  it("reads a taken workflow path and a taken template name both as exists", async () => {
    expect(
      await writeDocument(fakeClient(refusal(412, "file.precondition.exists")).client, create),
    ).toMatchObject({ ok: false, conflict: "exists" });
    expect(
      await writeDocument(fakeClient(refusal(409, "template.name-taken")).client, templatePost),
    ).toMatchObject({ ok: false, conflict: "exists" });
  });

  it("reads a late read-only refusal and a vanished file in the spec's words", async () => {
    expect(
      await writeDocument(
        fakeClient(refusal(403, "authored.shared-read-only")).client,
        templatePut,
      ),
    ).toEqual({
      ok: false,
      conflict: null,
      message: { key: "designer.document.readOnly" },
    });
    expect(
      await writeDocument(fakeClient(refusal(412, "file.precondition.missing")).client, overwrite),
    ).toEqual({ ok: false, conflict: null, message: { key: "designer.document.gone" } });
  });

  it("keeps a refusal it does not name as the Server's own message", async () => {
    // A size-limit 403 is not read-only: the Server's own message says why.
    const tooLarge = refusal(403, "authored.file-too-large");
    expect(await writeDocument(fakeClient(tooLarge).client, templatePut)).toEqual({
      ok: false,
      conflict: null,
      message: apiErrorMessage(tooLarge),
    });
  });

  it("reads any other failure as an error with its message", async () => {
    expect(
      await writeDocument(fakeClient(new PathApiError(500, "boom")).client, templatePut),
    ).toEqual({ ok: false, conflict: null, message: verbatim("boom") });
    expect(await writeDocument(fakeClient(new Error("offline")).client, overwrite)).toEqual({
      ok: false,
      conflict: null,
      message: verbatim("offline"),
    });
  });
});

describe("loadDocument", () => {
  it("opens a template's body inside a synthetic workflow file, its canonical bytes the baseline", async () => {
    const client = {
      getTemplate: async () => ({
        id: file.id,
        name: "flow",
        kind: "step",
        etag: '"t"',
        body: file.body,
      }),
    } as unknown as PathApiClient;
    const loaded = await loadDocument(client, loadingFrame(null, undefined, 1, template), []);
    expect(loaded).toMatchObject({ etag: '"t"', baseline: canonicalSerialize(file) });
  });

  it("has nothing to fetch for a from-scratch buffer", async () => {
    expect(await loadDocument({} as PathApiClient, scratchFrame(), [])).toBeNull();
  });

  it("turns a fetch failure into a frame error", async () => {
    const client = {
      getWorkflowFile: async () => Promise.reject(new Error("404 not found")),
    } as unknown as PathApiClient;
    expect(
      await loadDocument(client, loadingFrame("gone.workflow.json", undefined, 1), []),
    ).toMatchObject({
      frameState: { phase: "fetch-error", message: verbatim("404 not found") },
    });
  });
});
