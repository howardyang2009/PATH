import { existsSync } from "node:fs";
import { relative } from "node:path";
import { duplicateIdErrors, type StepPluginRegistry, safeParseWorkflowFile } from "@path/schema";
import {
  conditionalDelete,
  conditionalWrite,
  PRECONDITION_FAILED,
  serializeArtifact,
} from "./artifact-file.js";
import type { AuthoredLayout } from "./authored-layout.js";
import { confineToProjectRoot } from "./confine.js";
import { type CreatorTable, projectPathOf, sharedWriteRefusal } from "./creator-table.js";
import { editLease } from "./edit-lease.js";
import { fileSizeRefusal, sharedItemLimitRefusal, type UserLimits } from "./request-limits.js";

// The workflow store: the path-addressed door onto workflow files, as the template store is the
// id-addressed door onto templates. Both ask the authored layout which files a door may write, and
// the creator table who may change a shared one (ADR 0088).

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
  layout: AuthoredLayout;
  stepPlugins: StepPluginRegistry;
  creators: CreatorTable;
  /** The requester's request limits; `undefined` (local mode) checks none. */
  limits?: UserLimits;
}): WorkflowStore {
  const { layout, stepPlugins, creators, limits } = ctx;
  const { projectDir } = layout;
  const shared = (workflowPath: string): boolean =>
    layout.classify(workflowPath)?.origin === "shared";

  return {
    write(workflowPath, payload, ifMatch) {
      if (!layout.inView(workflowPath)) return { ok: false, status: 404, message: "not found" };
      const refusal = layout.workflowRefusal(workflowPath, "write");
      if (refusal !== undefined) return { ok: false, ...refusal };

      // Path confinement (404) before schema (400): a path that escapes the root or traverses a
      // symlink is refused regardless of the payload.
      const absPath = confineToProjectRoot(projectDir, workflowPath, { allowMissingTail: true });
      if (absPath === undefined) return { ok: false, status: 404, message: "not found" };
      // A new shared file is the requester's to create, within their shared-item limit; an existing
      // one only its creator's.
      const creatorRefusal = existsSync(absPath)
        ? sharedWriteRefusal(layout, creators, workflowPath, "workflow")
        : shared(workflowPath)
          ? sharedItemLimitRefusal(limits, creators, layout.userId)
          : undefined;
      if (creatorRefusal !== undefined) return { ok: false, ...creatorRefusal };

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
      const tooLarge = fileSizeRefusal(limits, Buffer.byteLength(serializeArtifact(payload)));
      if (tooLarge !== undefined) return { ok: false, ...tooLarge };

      const written = conditionalWrite(absPath, { ifMatch, rule: "create-or-overwrite", payload });
      if (!written.ok) {
        return { ok: false, status: 412, message: PRECONDITION_FAILED[written.conflict] };
      }
      if (written.created && shared(workflowPath)) {
        creators.stamp(projectPathOf(layout, workflowPath), "workflow", layout.userId);
      }
      return {
        ok: true,
        relativePath: relative(projectDir, absPath),
        id: validation.data.id,
        etag: written.etag,
        created: written.created,
      };
    },

    remove(workflowPath, ifMatch, sessionId) {
      if (!layout.inView(workflowPath)) return { ok: false, status: 404, message: "not found" };
      const refusal = layout.workflowRefusal(workflowPath, "write");
      if (refusal !== undefined) return { ok: false, ...refusal };

      const absPath = confineToProjectRoot(projectDir, workflowPath);
      const lease = editLease(projectDir, workflowPath);
      if (absPath === undefined || lease === undefined) {
        return { ok: false, status: 404, message: "not found" };
      }
      const creatorRefusal = sharedWriteRefusal(layout, creators, workflowPath, "workflow");
      if (creatorRefusal !== undefined) return { ok: false, ...creatorRefusal };
      // The lease first: another session editing the file outranks a stale token, and either way
      // the file is untouched.
      if (lease.heldByOther(sessionId)) {
        return { ok: false, status: 409, message: "workflow is being edited in another session" };
      }
      const removed = conditionalDelete(absPath, ifMatch);
      if (!removed.ok) {
        // A file that is already gone is the `404`; a missing or stale token is the `412`.
        return removed.conflict === "missing"
          ? { ok: false, status: 404, message: "not found" }
          : { ok: false, status: 412, message: PRECONDITION_FAILED[removed.conflict] };
      }
      lease.remove();
      if (shared(workflowPath)) creators.forget(projectPathOf(layout, workflowPath), "workflow");
      return { ok: true };
    },
  };
}
