import { instantiateWorkflow, type WorkflowFile } from "@path/schema";
import { openedResultOf, type SaveState, stemName, type TemplateSource } from "./frame.js";
import { IDLE, type SessionAction, type SessionState } from "./state.js";

/** The part of the session a plan reads: which frames exist, which is active, and the edit mode. The
 * save phase is the plan's *output*, never its input. */
export type PlanState = Pick<SessionState, "mode" | "frames" | "activeIndex">;

// ── The write vocabulary ────────────────────────────────────────────────────────────────────────

/** One document write: `workflow` — `PUT /v0/workflows`, overwrite under `ifMatch` or exclusive
 * create when absent; `template` — `PUT /v0/templates/:id` under `ifMatch`; `new-template` — `POST
 * /v0/templates`. */
export type DocumentWrite =
  | { to: "workflow"; path: string; ifMatch: string | undefined; file: WorkflowFile }
  | { to: "template"; id: string; ifMatch: string; description: string; file: WorkflowFile }
  | {
      to: "new-template";
      name: string;
      folder?: string;
      description: string;
      file: WorkflowFile;
    };

/** The written document's own echo. */
export interface WriteSuccess {
  etag: string;
  relativePath: string;
  id: string;
}

/** A write's outcome: the written document's echo, or why it was refused. `stale` is an overwrite
 * whose `If-Match` no longer matches; `exists` is a create whose target is taken; `null` is
 * anything else. */
export type WriteOutcome =
  | ({ ok: true } & WriteSuccess)
  | { ok: false; conflict: "stale" | "exists"; message: string }
  | { ok: false; conflict: null; message: string };

// ── The write plans, one per door ───────────────────────────────────────────────────────────────

/**
 * Every way the Designer writes the active buffer: the Save button, or one Save as… door. Each
 * intent names its own target and identity; what the write *is* — which door, under which token,
 * landing which action, showing which phase on a refusal — is {@link planWrite}'s.
 */
export type SaveAsIntent =
  | { kind: "new-file"; path: string }
  | { kind: "workflow-copy"; path: string }
  | { kind: "new-template"; name: string; folder?: string; description: string }
  | { kind: "template-copy"; name: string; folder?: string; description: string }
  | { kind: "workflow-as-template"; name: string; folder?: string; description: string };

export type WriteIntent = { kind: "save" } | SaveAsIntent;

/**
 * Why no write is possible. The reason also says what the surface should offer instead: a
 * from-scratch workflow buffer opens the first-save dialog, a from-scratch template buffer the
 * new-template one, and an unopened session nothing.
 */
export type WriteRefusalReason = "nothing-open" | "needs-workflow-path" | "needs-template-name";

export interface WriteRefusal {
  ok: false;
  reason: WriteRefusalReason;
  message: string;
}

/** The one write a door runs, and the two decisions the hook would otherwise re-derive. */
export interface WritePlan {
  ok: true;
  write: DocumentWrite;
  /**
   * The action that lands a success. `savedBytes` is the canonical serialization of the buffer
   * written, so a buffer the author edited during the in-flight save stays dirty against the new
   * baseline (ADR 0030).
   */
  landed(result: WriteSuccess, savedBytes: string): SessionAction;
  /** The phase a refusal leaves the session in: the stale-write conflict an author reloads from, an
   * error to read, or nothing at all when the surface owns the refusal (a Save as… dialog). */
  refused(outcome: { ok: false; conflict: "stale" | "exists" | null; message: string }): SaveState;
}

/** The standard refusal reading behind the doors that are not a first save: a stale token is the
 * conflict banner, anything else is an error. */
function conflictOrError(outcome: {
  conflict: "stale" | "exists" | null;
  message: string;
}): SaveState {
  return outcome.conflict === null
    ? { phase: "error", message: outcome.message }
    : { phase: "conflict", message: outcome.message };
}

/** A Save as… door's refusal is the dialog's to show, not the toolbar's. */
function dialogOwns(): SaveState {
  return IDLE;
}

/** What the Save button would write, or why it writes nothing. */
function saveInPlace(state: PlanState): WritePlan | WriteRefusal {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  if (!frame || !opened) {
    return { ok: false, reason: "nothing-open", message: "Nothing is open to save." };
  }
  if (frame.template) {
    // Author mode writes the envelope back by id; the read always carried an ETag.
    const id = frame.template.id;
    return {
      ok: true,
      write: {
        to: "template",
        id,
        ifMatch: frame.etag ?? "",
        description: frame.template.description,
        file: opened.file,
      },
      landed: (result, savedBytes) => ({
        type: "templateSaved",
        depth,
        id,
        etag: result.etag,
        savedBytes,
      }),
      refused: conflictOrError,
    };
  }
  if (frame.path === null) {
    return {
      ok: false,
      reason: state.mode === "template" ? "needs-template-name" : "needs-workflow-path",
      message: "The buffer has no path yet.",
    };
  }
  const path = frame.path;
  const write: DocumentWrite = frame.written
    ? { to: "workflow", path, ifMatch: frame.etag ?? undefined, file: opened.file }
    : { to: "workflow", path, ifMatch: undefined, file: opened.file };
  return {
    ok: true,
    write,
    landed: (result, savedBytes) => ({ type: "saved", depth, path, etag: result.etag, savedBytes }),
    // An unwritten buffer's path is pre-assigned to a child reference, so a taken target is the
    // author's to retarget, not a stale buffer to reload.
    refused: frame.written
      ? conflictOrError
      : () => ({
          phase: "error",
          message: `A workflow already exists at ${path}. Choose a different target for the reference.`,
        }),
  };
}

/** The active workflow-mode buffer, for the two Save-As doors that copy a workflow. */
function workflowBuffer(state: PlanState): { depth: number; file: WorkflowFile } | undefined {
  const opened = openedResultOf(state.frames[state.activeIndex]);
  if (state.mode !== "workflow" || !opened) return undefined;
  return { depth: state.activeIndex, file: opened.file };
}

/** The active template-mode buffer that holds no template yet — a new template's first save. */
function newTemplateBuffer(state: PlanState): { depth: number; file: WorkflowFile } | undefined {
  const frame = state.frames[state.activeIndex];
  const opened = openedResultOf(frame);
  if (state.mode !== "template" || !frame || frame.template || !opened) return undefined;
  return { depth: state.activeIndex, file: opened.file };
}

/** The active template frame's buffer and source, for the template Save-As doors. */
function templateBuffer(
  state: PlanState,
): { depth: number; file: WorkflowFile; template: TemplateSource } | undefined {
  const frame = state.frames[state.activeIndex];
  const opened = openedResultOf(frame);
  if (!frame?.template || !opened) return undefined;
  return { depth: state.activeIndex, file: opened.file, template: frame.template };
}

function planNewFile(
  state: PlanState,
  intent: { kind: "new-file"; path: string },
): WritePlan | WriteRefusal {
  const frame = state.frames[state.activeIndex];
  const opened = openedResultOf(frame);
  // Only a from-scratch **root** buffer picks its path here; a saved frame and a create-new child
  // go through Save.
  if (!frame || !opened || frame.written || frame.path !== null) {
    return { ok: false, reason: "needs-workflow-path", message: "No new-file buffer to save." };
  }
  return {
    ok: true,
    write: { to: "workflow", path: intent.path, ifMatch: undefined, file: opened.file },
    landed: (result, savedBytes) => ({
      type: "newFileSaved",
      depth: state.activeIndex,
      etag: result.etag,
      savedBytes,
      relativePath: result.relativePath,
    }),
    refused: conflictOrError,
  };
}

function planSaveAs(state: PlanState, intent: SaveAsIntent): WritePlan | WriteRefusal {
  switch (intent.kind) {
    case "new-file":
      return planNewFile(state, intent);

    case "workflow-copy": {
      const plan = workflowBuffer(state);
      if (!plan) {
        return { ok: false, reason: "needs-workflow-path", message: "No workflow to save." };
      }
      const file: WorkflowFile = { ...instantiateWorkflow(plan.file), name: stemName(intent.path) };
      return {
        ok: true,
        write: { to: "workflow", path: intent.path, ifMatch: undefined, file },
        landed: (result) => ({
          type: "detachedSaved",
          depth: plan.depth,
          fromId: plan.file.id,
          file,
          relativePath: result.relativePath,
          etag: result.etag,
        }),
        refused: dialogOwns,
      };
    }

    case "workflow-as-template": {
      const plan = workflowBuffer(state);
      if (!plan) {
        return { ok: false, reason: "needs-workflow-path", message: "No workflow to save." };
      }
      // Only the body survives; the workflow-level fields are dropped.
      const file: WorkflowFile = {
        format: plan.file.format,
        id: crypto.randomUUID(),
        name: intent.name,
        body: plan.file.body,
      };
      return {
        ok: true,
        write: {
          to: "new-template",
          name: intent.name,
          ...(intent.folder === undefined ? {} : { folder: intent.folder }),
          description: intent.description,
          file,
        },
        landed: () => ({
          type: "setSaveState",
          saveState: { phase: "saved-as-template", name: intent.name },
        }),
        refused: dialogOwns,
      };
    }

    case "new-template":
    case "template-copy": {
      const copy = intent.kind === "template-copy" ? templateBuffer(state) : undefined;
      const plan = copy ?? newTemplateBuffer(state);
      if (!plan) {
        return {
          ok: false,
          reason: "needs-template-name",
          message:
            intent.kind === "new-template"
              ? "No new template to save."
              : "No template source to save.",
        };
      }
      const fromId = copy?.template.id ?? null;
      const file: WorkflowFile = { ...plan.file, id: crypto.randomUUID() };
      const template: TemplateSource = {
        id: file.id,
        kind: "step",
        name: intent.name,
        description: intent.description,
        readOnly: false,
      };
      return {
        ok: true,
        write: {
          to: "new-template",
          name: intent.name,
          ...(intent.folder === undefined ? {} : { folder: intent.folder }),
          description: intent.description,
          file,
        },
        landed: (result) => ({
          type: "templateSavedAs",
          depth: plan.depth,
          fromId,
          template: { ...template, id: result.id },
          file,
          etag: result.etag,
        }),
        refused: dialogOwns,
      };
    }
  }
}

/**
 * The one authority over what the Designer writes: the Save button and every Save as… door plan
 * their write, its landing action and their own refusal reading here. A caller executes the plan and
 * dispatches; it decides nothing about doors, tokens, formats or identities.
 */
export function planWrite(state: PlanState, intent: WriteIntent): WritePlan | WriteRefusal {
  return intent.kind === "save" ? saveInPlace(state) : planSaveAs(state, intent);
}

// ── Delete ──────────────────────────────────────────────────────────────────────────────────────

/** What the Delete button would remove, or `null`. Delete acts on the **root** file only: a written
 * file through `DELETE /v0/workflows/file` under the read's `If-Match`, a user template through
 * `DELETE /v0/templates/:id`. A shipped template and a never-saved buffer have no plan. */
export type DeletePlan =
  | { kind: "workflow"; path: string; ifMatch: string }
  | { kind: "template"; id: string; name: string };

export function planDelete(state: PlanState): DeletePlan | null {
  if (state.activeIndex !== 0) return null;
  const frame = state.frames[0];
  if (frame?.state.phase !== "open") return null;
  if (frame.template)
    return frame.template.readOnly
      ? null
      : { kind: "template", id: frame.template.id, name: frame.template.name };
  if (!frame.written || frame.path === null || frame.etag === null) return null;
  return { kind: "workflow", path: frame.path, ifMatch: frame.etag };
}

// ── Download ────────────────────────────────────────────────────────────────────────────────────

/** What the Download button would save, or `null`: the **active** frame's saved file. A workflow
 * goes by its path (a zip when it refs other workflows), a template by id. A never-saved buffer has
 * no file to download. */
export type DownloadPlan = { kind: "workflow"; path: string } | { kind: "template"; id: string };

export function planDownload(state: PlanState): DownloadPlan | null {
  const frame = state.frames[state.activeIndex];
  if (frame?.state.phase !== "open") return null;
  if (frame.template) return { kind: "template", id: frame.template.id };
  return frame.path === null ? null : { kind: "workflow", path: frame.path };
}
