import { describe, expect, it } from "vitest";
import { PathApiError, type PathApiClient } from "@path/client-core";
import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { documentPolicy, loadDocument, writeDocument, type DocumentWrite } from "../src/document.js";
import { canonicalSerialize } from "../src/serialize.js";
import { loadingFrame, scratchFrame, type Frame, type SessionState, type TemplateSource } from "../src/session-reducer.js";

/**
 * The open document (`document.ts`) through its own interface: the session policy the toolbar and the
 * lease read, and the one write whose refusals read the same across both doors — with a fake client and
 * no App.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

const file: WorkflowFile = { format: FORMAT_VERSION, id: uuid(1), name: "flow", body: [{ type: "prompt", id: uuid(2), name: "step", prompt: "" } as WorkflowNode] };

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

const template: TemplateSource = { id: uuid(9), kind: "step", name: "review", description: "d", readOnly: false };

function session(frames: Frame[], mode: SessionState["mode"] = "workflow", activeIndex = frames.length - 1) {
  return { frames, activeIndex, mode };
}

describe("documentPolicy", () => {
  it("saves a written workflow in place and leases its path", () => {
    expect(documentPolicy(session([openFrame()]))).toEqual({ saveDoor: "save", canSaveAs: true, leasedPaths: ["flow.workflow.json"] });
  });

  it("opens the first-save dialog of the mode for a from-scratch buffer, with no Save as… and no lease", () => {
    expect(documentPolicy(session([scratchFrame()]))).toEqual({ saveDoor: "new-workflow-dialog", canSaveAs: false, leasedPaths: [] });
    expect(documentPolicy(session([scratchFrame()], "template"))).toMatchObject({ saveDoor: "new-template-dialog" });
  });

  it("saves a template source in place by id, with no lease", () => {
    expect(documentPolicy(session([openFrame({ path: null, template })], "template"))).toEqual({ saveDoor: "save", canSaveAs: true, leasedPaths: [] });
  });

  it("saves a create-new child at its path but leases only written frames on the stack", () => {
    const child = scratchFrame("child.workflow.json", { depth: 0, nodeId: uuid(2) });
    expect(documentPolicy(session([openFrame(), child]))).toEqual({ saveDoor: "save", canSaveAs: true, leasedPaths: ["flow.workflow.json"] });
  });

  it("offers nothing while the active frame is still loading", () => {
    expect(documentPolicy(session([loadingFrame("flow.workflow.json", undefined, 1)]))).toEqual({ saveDoor: null, canSaveAs: false, leasedPaths: [] });
  });
});

/** A client whose three write calls resolve, or reject with `error`, recording what they were sent. */
function fakeClient(error?: Error) {
  const calls: { method: string; input: unknown }[] = [];
  const answer = (method: string) => async (input: unknown) => {
    calls.push({ method, input });
    if (error) throw error;
    return { etag: '"new"', relativePath: "out.workflow.json", id: uuid(3) };
  };
  const client = { putWorkflow: answer("putWorkflow"), putTemplate: answer("putTemplate"), createTemplate: answer("createTemplate") } as unknown as PathApiClient;
  return { client, calls };
}

describe("writeDocument", () => {
  const overwrite: DocumentWrite = { to: "workflow", path: "flow.workflow.json", ifMatch: '"old"', file };
  const create: DocumentWrite = { to: "workflow", path: "flow.workflow.json", ifMatch: undefined, file };
  const templatePut: DocumentWrite = { to: "template", id: template.id, ifMatch: '"old"', description: "d", file };
  const templatePost: DocumentWrite = { to: "new-template", name: "review", description: "d", file };

  it("echoes the written document", async () => {
    const { client, calls } = fakeClient();
    expect(await writeDocument(client, overwrite)).toEqual({ ok: true, etag: '"new"', relativePath: "out.workflow.json", id: uuid(3) });
    expect(calls[0]).toMatchObject({ method: "putWorkflow", input: { workflowPath: "flow.workflow.json", ifMatch: '"old"' } });
  });

  it("wraps a template's body in its envelope", async () => {
    const { client, calls } = fakeClient();
    await writeDocument(client, templatePost);
    expect(calls[0]).toMatchObject({
      method: "createTemplate",
      input: { kind: "step", name: "review", description: "d", body: { format: FORMAT_VERSION, id: file.id, description: "d", body: file.body } },
    });
  });

  it("reads an overwrite's 412 as stale on both doors", async () => {
    const { client } = fakeClient(new PathApiError(412, "changed"));
    expect(await writeDocument(client, overwrite)).toMatchObject({ ok: false, conflict: "stale" });
    expect(await writeDocument(client, templatePut)).toMatchObject({ ok: false, conflict: "stale" });
  });

  it("reads a workflow create's 412 and a template create's 409 both as exists", async () => {
    expect(await writeDocument(fakeClient(new PathApiError(412, "taken")).client, create)).toMatchObject({ ok: false, conflict: "exists" });
    expect(await writeDocument(fakeClient(new PathApiError(409, "taken")).client, templatePost)).toMatchObject({ ok: false, conflict: "exists" });
  });

  it("reads any other failure as an error with its message", async () => {
    expect(await writeDocument(fakeClient(new PathApiError(403, "read-only")).client, templatePut)).toEqual({ ok: false, conflict: null, message: "read-only" });
    expect(await writeDocument(fakeClient(new Error("offline")).client, overwrite)).toEqual({ ok: false, conflict: null, message: "offline" });
  });
});

describe("loadDocument", () => {
  it("opens a template's body inside a synthetic workflow file, its canonical bytes the baseline", async () => {
    const client = {
      getTemplate: async () => ({ id: file.id, name: "flow", kind: "step", etag: '"t"', body: file.body }),
    } as unknown as PathApiClient;
    const loaded = await loadDocument(client, loadingFrame(null, undefined, 1, template), []);
    expect(loaded).toMatchObject({ etag: '"t"', baseline: canonicalSerialize(file) });
  });

  it("has nothing to fetch for a from-scratch buffer", async () => {
    expect(await loadDocument({} as PathApiClient, scratchFrame(), [])).toBeNull();
  });

  it("turns a fetch failure into a frame error", async () => {
    const client = { getWorkflowFile: async () => Promise.reject(new Error("404 not found")) } as unknown as PathApiClient;
    expect(await loadDocument(client, loadingFrame("gone.workflow.json", undefined, 1), [])).toMatchObject({
      frameState: { phase: "fetch-error", message: "404 not found" },
    });
  });
});
