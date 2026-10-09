import { relative } from "node:path";
import { duplicateIdErrors, type StepPluginRegistry, safeParseWorkflowFile } from "@path/schema";
import {
  conditionalDelete,
  conditionalWrite,
  PRECONDITION_FAILED,
  serializeArtifact,
} from "./artifact-file.js";
import { editLease } from "./edit-lease.js";
import type { WriteAccess } from "./write-access.js";

// The workflow store: the path-addressed door onto workflow files, as the template store is the
// id-addressed door onto templates. Both ask the requester's write access which files a door may
// change (ADR 0088).

export type WorkflowWrite =
  | { ok: true; relativePath: string; id: string; etag: string; created: boolean }
  | { ok: false; status: 400 | 403 | 404 | 412; message: string; details?: string[] };

export type WorkflowRemove =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404 | 409 | 412; message: string };

export interface WorkflowStore {
  /** Create or overwrite the workflow at `workflowPath` with a valid file, gated on `If-Match`
   * (ADR 0016): present is overwrite-only, absent is create-only. */
  write(workflowPath: string, payload: unknown, ifMatch: string | undefined): WorkflowWrite;
  /** Remove the workflow at `workflowPath` when `ifMatch` is its current etag and no other session
   * holds its edit lease (ADR 0017); the lease goes with it. */
  remove(
    workflowPath: string,
    ifMatch: string | undefined,
    sessionId: string | null,
  ): WorkflowRemove;
}

export function workflowsOf(ctx: {
  access: WriteAccess;
  stepPlugins: StepPluginRegistry;
}): WorkflowStore {
  const { access, stepPlugins } = ctx;
  const { projectDir } = access.layout;

  return {
    write(workflowPath, payload, ifMatch) {
      // Path and access (404, 403) before schema (400): a path the requester may not change is
      // refused regardless of the payload.
      const target = access.workflow(workflowPath);
      if (!target.ok) return target;
      const { absPath } = target;
      const origin = access.layout.classify(workflowPath)?.origin ?? "user";
      const createRefusal = target.exists ? undefined : access.createRefusal(origin);
      if (createRefusal !== undefined) return { ok: false, ...createRefusal };

      // Parsed against the registry frozen at server start (ADR 0018), like every other door that
      // validates a file.
      const validation = safeParseWorkflowFile(payload, stepPlugins);
      if (!validation.success) {
        return {
          ok: false,
          status: 400,
          message: "workflow validation failed",
          details: validation.errors,
        };
      }
      const duplicates = duplicateIdErrors(validation.data);
      if (duplicates.length > 0) {
        return {
          ok: false,
          status: 400,
          message: "workflow validation failed",
          details: duplicates,
        };
      }
      const tooLarge = access.sizeRefusal(Buffer.byteLength(serializeArtifact(payload)));
      if (tooLarge !== undefined) return { ok: false, ...tooLarge };

      const written = conditionalWrite(absPath, { ifMatch, rule: "create-or-overwrite", payload });
      if (!written.ok) {
        return { ok: false, status: 412, message: PRECONDITION_FAILED[written.conflict] };
      }
      if (written.created) access.created(workflowPath, "workflow");
      return {
        ok: true,
        relativePath: relative(projectDir, absPath),
        id: validation.data.id,
        etag: written.etag,
        created: written.created,
      };
    },

    remove(workflowPath, ifMatch, sessionId) {
      const target = access.workflow(workflowPath);
      if (!target.ok) return target;
      const lease = editLease(projectDir, workflowPath);
      if (!target.exists || lease === undefined) {
        return { ok: false, status: 404, message: "not found" };
      }
      // The lease first: another session editing the file outranks a stale token, and either way
      // the file is untouched.
      if (lease.heldByOther(sessionId)) {
        return { ok: false, status: 409, message: "workflow is being edited in another session" };
      }
      const removed = conditionalDelete(target.absPath, ifMatch);
      if (!removed.ok) {
        // A file that is already gone is the `404`; a missing or stale token is the `412`.
        return removed.conflict === "missing"
          ? { ok: false, status: 404, message: "not found" }
          : { ok: false, status: 412, message: PRECONDITION_FAILED[removed.conflict] };
      }
      lease.remove();
      access.removed(workflowPath, "workflow");
      return { ok: true };
    },
  };
}
