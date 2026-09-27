import type { WorkflowFile } from "@path/schema";
import { openedResultOf, type TemplateSource } from "./frame.js";
import type { SessionState } from "./state.js";

// ── The save doors, as decisions the hook performs ───────────────────────────────────────────────

/** What the Save button would do, or `null`. The door is the session's own choice: **overwrite**
 * under the read's `If-Match` ETag (ADR 0016), **create** exclusively at the pre-assigned path, or
 * **template** write-back by id (`PUT /v0/templates/:id`). A from-scratch root picks its path in
 * the first-save dialog. */
export type SavePlan =
  | {
      kind: "overwrite";
      depth: number;
      path: string;
      file: WorkflowFile;
      ifMatch: string | undefined;
    }
  | { kind: "create"; depth: number; path: string; file: WorkflowFile; ifMatch: undefined }
  | {
      kind: "template";
      depth: number;
      id: string;
      template: TemplateSource;
      file: WorkflowFile;
      ifMatch: string;
    };

export function planSave(state: SessionState): SavePlan | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  if (frame?.template && opened) {
    // The read always carries an ETag; an empty token would only earn the honest `412`.
    return {
      kind: "template",
      depth,
      id: frame.template.id,
      template: frame.template,
      file: opened.file,
      ifMatch: frame.etag ?? "",
    };
  }
  if (!frame || !opened || frame.path === null) return null;
  return frame.written
    ? {
        kind: "overwrite",
        depth,
        path: frame.path,
        file: opened.file,
        ifMatch: frame.etag ?? undefined,
      }
    : { kind: "create", depth, path: frame.path, file: opened.file, ifMatch: undefined };
}

/** What the Delete button would remove, or `null`. Delete acts on the **root** file only: a written
 * file through `DELETE /v0/workflows/file` under the read's `If-Match`, a user template through
 * `DELETE /v0/templates/:id`. A shipped template and a never-saved buffer have no plan. */
export type DeletePlan =
  | { kind: "workflow"; path: string; ifMatch: string }
  | { kind: "template"; id: string; name: string };

export function planDelete(state: SessionState): DeletePlan | null {
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

/** What the first-save dialog's target would do, or `null` when the active frame is not a
 * from-scratch root. */
export interface NewFileSavePlan {
  depth: number;
  file: WorkflowFile;
}

export function planNewFileSave(state: SessionState): NewFileSavePlan | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  // Only a from-scratch root picks its path here; a create-new child and a saved frame go through
  // `planSave`.
  if (!frame || !opened || frame.written || frame.path !== null) return null;
  return { depth, file: opened.file };
}

/** What the two author-mode Save-As doors start from: the active template frame's buffer and its
 * source, or `null`. Each door derives its own new identity from `file`. */
export interface TemplateSaveAsPlan {
  depth: number;
  template: TemplateSource;
  file: WorkflowFile;
}

export function planTemplateSaveAs(state: SessionState): TemplateSaveAsPlan | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  if (!frame?.template || !opened) return null;
  return { depth, template: frame.template, file: opened.file };
}

/** What a workflow-mode Save as… starts from: the active opened buffer in workflow mode, or
 * `null`. */
export function planWorkflowSaveAs(state: SessionState): NewFileSavePlan | null {
  const depth = state.activeIndex;
  const opened = openedResultOf(state.frames[depth]);
  if (state.mode !== "workflow" || !opened) return null;
  return { depth, file: opened.file };
}

/**
 * What a new template's first save starts from: the active template-mode buffer that holds no
 * template yet, or `null`.
 */
export function planNewTemplateSave(state: SessionState): NewFileSavePlan | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  if (state.mode !== "template" || !frame || frame.template || !opened) return null;
  return { depth, file: opened.file };
}
