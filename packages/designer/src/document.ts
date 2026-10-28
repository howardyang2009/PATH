import {
  type JsonValue,
  type PathApiClient,
  PathApiError,
  type WireStepPlugin,
} from "@path/client-core";
import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { errorMessage } from "@path/viewer";
import { openWorkflowFile } from "./open-workflow.js";
import { canonicalSerialize } from "./serialize.js";
import {
  type DocumentWrite,
  type PlanState,
  planWrite,
  type WriteOutcome,
  type WriteSuccess,
} from "./session/save-plan.js";
import { type Frame, openedResultOf } from "./session-reducer.js";

export type { DocumentWrite, WriteOutcome } from "./session/save-plan.js";

/** The Designer's open document: a workflow file, path-addressed through `PUT /v0/workflows`, or a
 * step-template, id-addressed through the template API. Both open into one buffer and save by one
 * write. */

/** What a fetch of one frame lands: its open outcome, its read ETag, and its save-point
 * baseline. */
export interface LoadedDocument {
  frameState: Frame["state"];
  etag: string | null;
  baseline: string;
  openedBytes: string;
}

function opened(text: string, plugins: WireStepPlugin[], etag: string | null): LoadedDocument {
  const result = openWorkflowFile(text, plugins);
  // The baseline is the bytes read: a buffer whose canonical serialization differs — an id-stamp
  // repair, or a non-canonical hand-authored file — opens dirty. `openedBytes` is the buffer's
  // canonical form at open.
  const openedBytes = result.status === "opened" ? canonicalSerialize(result.file) : "";
  return { frameState: { phase: "open", result }, etag, baseline: text, openedBytes };
}

/** Fetch the document a loading frame stands for: a workflow file by path (raw bytes are the
 * baseline), or a template by id (no raw bytes, so its baseline is the canonical serialization). A
 * fetch failure becomes a frame error; `null` for a frame with nothing to fetch. */
export async function loadDocument(
  client: PathApiClient,
  frame: Frame,
  plugins: WireStepPlugin[],
): Promise<LoadedDocument | null> {
  const { path, template } = frame;
  try {
    if (template) {
      const envelope = await client.getTemplate(template.id);
      const file: WorkflowFile = {
        format: FORMAT_VERSION,
        id: envelope.id,
        name: envelope.name,
        body: envelope.body as WorkflowNode[],
      };
      return opened(canonicalSerialize(file), plugins, envelope.etag);
    }
    if (path === null) return null;
    const raw = await client.getWorkflowFile(path);
    return opened(raw.text, plugins, raw.etag);
  } catch (error) {
    return {
      frameState: { phase: "fetch-error", message: errorMessage(error) },
      etag: null,
      baseline: "",
      openedBytes: "",
    };
  }
}

/** The template object a template write sends: a step-template envelope around the buffer's
 * body. */
function templateBody(description: string, file: WorkflowFile): Record<string, unknown> {
  return { format: FORMAT_VERSION, id: file.id, description, body: file.body };
}

/** Run one document write and read its refusal in document terms (see {@link writeRefusal}). */
export async function writeDocument(
  client: PathApiClient,
  write: DocumentWrite,
): Promise<WriteOutcome> {
  try {
    // The whole authored model, ids and all — the server preserves every `id` it is sent.
    const result =
      write.to === "workflow"
        ? await client.putWorkflow({
            workflowPath: write.path,
            workflow: write.file as unknown as JsonValue,
            ifMatch: write.ifMatch,
          })
        : write.to === "template"
          ? await client.putTemplate({
              id: write.id,
              body: templateBody(write.description, write.file) as JsonValue,
              ifMatch: write.ifMatch,
            })
          : await client.createTemplate({
              kind: "step",
              name: write.name,
              ...(write.folder === undefined ? {} : { folder: write.folder }),
              ...(write.origin === undefined ? {} : { origin: write.origin }),
              description: write.description,
              body: templateBody(write.description, write.file),
            });
    return { ok: true, ...(result satisfies WriteSuccess) };
  } catch (error) {
    return writeRefusal(error);
  }
}

/** The error codes (ADR 0107) an authored write's refusal is read by: a create whose target is
 * taken, an overwrite whose `If-Match` no longer matches, a file gone since it was read, and a file
 * the requester may not change. */
const REFUSALS: Record<string, "exists" | "stale" | "gone" | "readOnly"> = {
  "file.precondition.exists": "exists",
  "template.name-taken": "exists",
  "template.id-taken": "exists",
  "file.precondition.changed": "stale",
  "file.precondition.required": "stale",
  "file.precondition.missing": "gone",
  "request.not-found": "gone",
  "authored.shared-read-only": "readOnly",
  "template.read-only": "readOnly",
  "workflow.shipped-read-only": "readOnly",
};

/** A failed authored write in document terms, read from its error code: every write door — save,
 * save-as, Upload — reads a refusal here. Any other failure keeps its own message. */
export function writeRefusal(error: unknown): Exclude<WriteOutcome, { ok: true }> {
  const refusal = error instanceof PathApiError ? REFUSALS[error.code ?? ""] : undefined;
  if (refusal === "exists" || refusal === "stale") {
    return { ok: false, conflict: refusal, message: errorMessage(error) };
  }
  if (refusal !== undefined) {
    return { ok: false, conflict: null, message: { key: `designer.document.${refusal}` } };
  }
  return { ok: false, conflict: null, message: errorMessage(error) };
}

/**
 * The door the toolbar's Save opens for the active frame: `save` in place (a written file, a
 * create-new child at its pre-assigned path, or a template source by id), or the first-save dialog
 * of a new buffer. `null` when nothing is open.
 */
export type SaveDoor = "save" | "new-workflow-dialog" | "new-template-dialog";

/** The session policy the surfaces read, derived from the session state alone. */
export interface DocumentPolicy {
  saveDoor: SaveDoor | null;
  /** Save as… is offered for an opened document that already has an identity (a path or a
   * template). */
  canSaveAs: boolean;
  /**
   * The paths that hold an edit lease: every opened, written, path-bearing frame on the stack. A
   * frame that failed to open, an unwritten buffer, and a template (id-addressed) take none.
   */
  leasedPaths: string[];
}

export function documentPolicy(state: PlanState): DocumentPolicy {
  const active = state.frames[state.activeIndex];
  const isOpen = openedResultOf(active) !== null;
  const hasIdentity = Boolean(active?.path || active?.template);
  // The door is the write plan's own answer: a plan means Save writes this buffer, and a refusal
  // names the surface that must ask for the missing identity first.
  const door = planWrite(state, { kind: "save" });
  return {
    saveDoor: door.ok
      ? "save"
      : door.reason === "needs-template-name"
        ? "new-template-dialog"
        : door.reason === "needs-workflow-path"
          ? "new-workflow-dialog"
          : null,
    canSaveAs: isOpen && hasIdentity,
    leasedPaths: state.frames
      .filter((frame) => openedResultOf(frame) !== null && frame.written && frame.path !== null)
      .map((frame) => frame.path as string),
  };
}
