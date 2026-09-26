import { PathApiError, type JsonValue, type PathApiClient, type WireStepPlugin } from "@path/client-core";
import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { openWorkflowFile } from "./open-workflow.js";
import { canonicalSerialize } from "./serialize.js";
import { openedResultOf, type Frame, type SessionState } from "./session-reducer.js";

/**
 * The Designer's **open document**, as the two kinds of file it edits: a workflow file, path-addressed
 * through the workflow write door (`PUT /v0/workflows`, ADR 0016), and a step-template, id-addressed
 * through the template API (ADR 0050). Both open into one buffer — a template's `body` opens inside a
 * synthetic workflow file — and both save by one write, whose conflicts read the same way whatever the
 * door's own status code: a **stale** overwrite (someone else wrote it; reload) or an **exists** create
 * (the name is taken; choose another).
 *
 * The session policy the surfaces read — which save door the toolbar's Save opens, whether Save as… is
 * offered, which frames hold an edit lease — is answered here too, from the session state alone, so a
 * rule about a document kind has one home and one test surface without mounting the App.
 */

/** What a fetch of one frame lands: its open outcome, its read ETag, and its save-point baseline. */
export interface LoadedDocument {
  frameState: Frame["state"];
  etag: string | null;
  baseline: string;
  openedBytes: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function opened(text: string, plugins: WireStepPlugin[], etag: string | null): LoadedDocument {
  const result = openWorkflowFile(text, plugins);
  // The baseline is the bytes read (ADR 0030): a buffer whose canonical serialization differs from them —
  // an id-stamp repair, or a non-canonical hand-authored file — opens dirty, because a save would write
  // different bytes. `openedBytes` is the buffer's own canonical form at open, for the badge wording.
  const openedBytes = result.status === "opened" ? canonicalSerialize(result.file) : "";
  return { frameState: { phase: "open", result }, etag, baseline: text, openedBytes };
}

/**
 * Fetch the document a loading frame stands for and run the open pipeline over it: a workflow file by
 * its path (the raw on-disk bytes are the baseline), or a template source by its id. A template carries
 * no raw bytes, so its baseline is the canonical serialization of the synthetic file; one the open parse
 * re-orders therefore opens dirty, as a hand-authored workflow does. A fetch failure (404, …) becomes a
 * frame error. `null` for a frame with nothing to fetch (a from-scratch buffer).
 */
export async function loadDocument(client: PathApiClient, frame: Frame, plugins: WireStepPlugin[]): Promise<LoadedDocument | null> {
  const { path, template } = frame;
  if (!template && path === null) return null;
  try {
    if (template) {
      const envelope = await client.getTemplate(template.id);
      const file: WorkflowFile = { format: FORMAT_VERSION, id: envelope.id, name: envelope.name, body: envelope.body as WorkflowNode[] };
      return opened(canonicalSerialize(file), plugins, envelope.etag);
    }
    const raw = await client.getWorkflowFile(path!);
    return opened(raw.text, plugins, raw.etag);
  } catch (error) {
    return { frameState: { phase: "fetch-error", message: errorMessage(error) }, etag: null, baseline: "", openedBytes: "" };
  }
}

/** The template object a template write sends: a step-template envelope around the buffer's body (ADR 0048). */
function templateBody(description: string, file: WorkflowFile): Record<string, unknown> {
  return { format: FORMAT_VERSION, id: file.id, description, body: file.body };
}

/**
 * One document write:
 *
 * - `workflow` — `PUT /v0/workflows` at `path`: an overwrite under `ifMatch`, or an exclusive create when
 *   it is absent (ADR 0016);
 * - `template` — `PUT /v0/templates/:id`, an overwrite under `ifMatch` (a shipped template answers `403`);
 * - `new-template` — `POST /v0/templates`, an exclusive create of a user template named `name`.
 */
export type DocumentWrite =
  | { to: "workflow"; path: string; ifMatch: string | undefined; file: WorkflowFile }
  | { to: "template"; id: string; ifMatch: string; description: string; file: WorkflowFile }
  | { to: "new-template"; name: string; description: string; file: WorkflowFile };

/** A write's outcome: the written document's echo, or why it was refused. */
export type WriteOutcome =
  | { ok: true; etag: string; relativePath: string; id: string }
  /** `stale` — an overwrite whose `If-Match` no longer matches; `exists` — a create whose target is taken. */
  | { ok: false; conflict: "stale" | "exists"; message: string }
  | { ok: false; conflict: null; message: string };

/**
 * Run one document write and read its refusal in document terms. An overwrite's `412` is **stale**; a
 * workflow create's `412` and a template create's `409` are both **exists** — the two doors spell the
 * same collision differently (ADR 0016, ADR 0050 decision 6), and no caller has to know which.
 */
export async function writeDocument(client: PathApiClient, write: DocumentWrite): Promise<WriteOutcome> {
  try {
    // The whole authored model, ids and all — the server preserves every `id` it is sent (ADR 0015).
    const result =
      write.to === "workflow"
        ? await client.putWorkflow({ workflowPath: write.path, workflow: write.file as unknown as JsonValue, ifMatch: write.ifMatch })
        : write.to === "template"
          ? await client.putTemplate({ id: write.id, body: templateBody(write.description, write.file) as JsonValue, ifMatch: write.ifMatch })
          : await client.createTemplate({ kind: "step", name: write.name, description: write.description, body: templateBody(write.description, write.file) });
    return { ok: true, ...result };
  } catch (error) {
    const message = errorMessage(error);
    if (error instanceof PathApiError) {
      const creates = write.to === "new-template" || (write.to === "workflow" && write.ifMatch === undefined);
      if (error.status === 412) return { ok: false, conflict: creates ? "exists" : "stale", message };
      if (error.status === 409 && write.to === "new-template") return { ok: false, conflict: "exists", message };
    }
    return { ok: false, conflict: null, message };
  }
}

/**
 * The door the toolbar's Save opens for the active frame: `save` in place (a written file, a create-new
 * child at its pre-assigned path, or a template source by id), or the first-save dialog of a new buffer
 * in its mode. `null` when nothing is open.
 */
export type SaveDoor = "save" | "new-workflow-dialog" | "new-template-dialog";

/** The session policy the surfaces read, derived from the session state alone. */
export interface DocumentPolicy {
  saveDoor: SaveDoor | null;
  /** Save as… is offered for an opened document that already has an identity (a path or a template). */
  canSaveAs: boolean;
  /**
   * The paths that hold an edit lease (ADR 0017): every opened, written, path-bearing frame on the stack.
   * A frame that failed to open, an unwritten buffer, and a template (id-addressed) take none.
   */
  leasedPaths: string[];
}

export function documentPolicy(state: Pick<SessionState, "mode" | "frames" | "activeIndex">): DocumentPolicy {
  const active = state.frames[state.activeIndex];
  const isOpen = openedResultOf(active) !== null;
  const hasIdentity = Boolean(active?.path || active?.template);
  return {
    saveDoor: !isOpen ? null : hasIdentity ? "save" : state.mode === "template" ? "new-template-dialog" : "new-workflow-dialog",
    canSaveAs: isOpen && hasIdentity,
    leasedPaths: state.frames
      .filter((frame) => openedResultOf(frame) !== null && frame.written && frame.path !== null)
      .map((frame) => frame.path as string),
  };
}
