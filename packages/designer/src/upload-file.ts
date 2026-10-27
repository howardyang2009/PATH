import { apiErrorMessage, type PathApiClient, PathApiError } from "@path/client-core";
import type { Message } from "@path/i18n";
import type { TemplateSource } from "./session-reducer.js";
import {
  checkUploadFile,
  NO_USER_ROOT,
  planUpload,
  readUpload,
  type Upload,
  type UploadPlan,
  userWorkflowPath,
} from "./upload.js";

/** The file an upload wrote, to open next. */
export type UploadTarget =
  | { kind: "workflow"; path: string }
  | { kind: "template"; template: TemplateSource };

/** Where an upload stopped: written, waiting for a copy's new name, refused, or cancelled. */
export type UploadOutcome =
  | { status: "done"; target: UploadTarget }
  | { status: "copy"; upload: Upload }
  | { status: "refused"; message: Message }
  | { status: "cancelled" };

/** This Designer's edit-lease session and the paths it holds a lease on: a replace never releases
 * a lease the Designer held before the upload. */
export interface UploadLease {
  sessionId: string;
  heldPaths: readonly string[];
}

export interface UploadContext {
  /** Ask before an upload overwrites the requester's own file of the same name and id. */
  confirmReplace: (fileName: string) => boolean;
  lease: UploadLease;
}

/** Check and read one picked file, before the user picks its folder. */
export async function readPickedFile(
  file: File,
): Promise<{ status: "read"; upload: Upload } | { status: "refused"; message: Message }> {
  const checked = checkUploadFile(file);
  if (!checked.ok) return { status: "refused", message: checked.message };
  const read = readUpload(checked, await file.text());
  if (!read.ok) return { status: "refused", message: read.message };
  return { status: "read", upload: read.upload };
}

/** Plan a read file in its picked folder, then write it unless it must go in as a copy. */
export async function startUpload(
  client: PathApiClient,
  upload: Upload,
  context: UploadContext,
): Promise<UploadOutcome> {
  try {
    const [{ workflows, roots }, { templates }] = await Promise.all([
      client.listWorkflows(),
      client.listTemplates(),
    ]);
    const plan = planUpload(upload, { workflows, roots, templates });
    if (plan.action === "refuse") return { status: "refused", message: plan.message };
    if (plan.action === "copy") return { status: "copy", upload };
    if (plan.action === "replace" && !context.confirmReplace(upload.fileName)) {
      return { status: "cancelled" };
    }
    return await writeUpload(client, upload, plan, context.lease);
  } catch (error) {
    return { status: "refused", message: apiErrorMessage(error) };
  }
}

/** Write `upload` as a new file named `name` in its folder, under a fresh id. */
export async function uploadCopy(
  client: PathApiClient,
  upload: Upload,
  name: string,
): Promise<UploadOutcome> {
  const suffix = upload.fileName.slice(upload.stem.length);
  const checked = checkUploadFile({ name: `${name}${suffix}`, size: 0 });
  if (!checked.ok) return { status: "refused", message: checked.message };
  const copy: Upload = {
    ...upload,
    stem: checked.stem,
    fileName: checked.fileName,
    content: { ...upload.content, id: crypto.randomUUID() },
  };
  try {
    if (copy.kind === "template") return await writeUpload(client, copy, { action: "create" });
    const { roots } = await client.listWorkflows();
    const path = userWorkflowPath(roots, copy.folder, copy.fileName);
    if (path === undefined) return { status: "refused", message: NO_USER_ROOT };
    return await writeUpload(client, copy, { action: "create", path });
  } catch (error) {
    return { status: "refused", message: apiErrorMessage(error) };
  }
}

/** Write `upload` as `plan` says. Only a workflow replace takes a lease, so only it needs `lease`. */
async function writeUpload(
  client: PathApiClient,
  upload: Upload,
  plan: Exclude<UploadPlan, { action: "copy" | "refuse" }>,
  lease?: UploadLease,
): Promise<UploadOutcome> {
  if (!("path" in plan)) return writeTemplate(client, upload, plan);
  const { path } = plan;
  if (plan.action === "create") {
    try {
      await client.putWorkflow({ workflowPath: path, workflow: upload.content });
    } catch (error) {
      // A create-only write's one conflict: a file appeared at the path since the plan.
      if (!(error instanceof PathApiError && error.status === 412)) throw error;
      const params = { name: upload.fileName };
      return { status: "refused", message: { key: "designer.upload.nameTaken", params } };
    }
    return { status: "done", target: { kind: "workflow", path } };
  }
  // The lease is politeness the write door does not check (ADR 0017), so ask for it first: an
  // upload never overwrites a file someone has open.
  const sessionId = lease?.sessionId ?? crypto.randomUUID();
  const acquired = await client.acquireLock({ workflowPath: path, sessionId });
  if (acquired.status === "held-by-other") {
    return { status: "refused", message: { key: "errors.lease.held" } };
  }
  try {
    const { etag } = await client.getWorkflowFile(path);
    await client.putWorkflow({
      workflowPath: path,
      workflow: upload.content,
      ifMatch: etag ?? undefined,
    });
  } finally {
    if (!lease?.heldPaths.includes(path))
      await client.releaseLock({ workflowPath: path, sessionId });
  }
  return { status: "done", target: { kind: "workflow", path } };
}

async function writeTemplate(
  client: PathApiClient,
  upload: Upload,
  plan: Exclude<UploadPlan, { action: "copy" | "refuse" } | { path: string }>,
): Promise<UploadOutcome> {
  const description = String(upload.content.description ?? "");
  const written =
    "id" in plan
      ? await client.putTemplate({
          id: plan.id,
          body: upload.content,
          ifMatch: (await client.getTemplate(plan.id)).etag,
        })
      : await client.createTemplate({
          kind: "step",
          name: upload.stem,
          ...(upload.folder === "" ? {} : { folder: upload.folder }),
          description,
          body: upload.content,
        });
  return {
    status: "done",
    target: {
      kind: "template",
      template: { id: written.id, kind: "step", name: upload.stem, description, readOnly: false },
    },
  };
}
