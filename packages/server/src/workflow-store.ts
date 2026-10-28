import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { englishText, type Message } from "@path/i18n";
import {
  duplicateIdIssues,
  type ListWorkflowsResponse,
  type StepPluginRegistry,
  safeParseWorkflowFile,
  type WorkflowSummary,
} from "@path/schema";
import { conditionalDelete, PRECONDITION_FAILED } from "./artifact-file.js";
import { writableRoots } from "./authored-layout.js";
import { loadAuthoredWorkflow } from "./authored-read.js";
import { editLease } from "./edit-lease.js";
import { type Refusal, wireError } from "./http-json.js";
import type { WriteAccess } from "./write-access.js";

/** The first issue in English, the row's `message` for `curl` and an old client. */
function firstText(issues: Message[]): string | undefined {
  return issues[0] && englishText(issues[0]);
}

/** Best-effort top-level `id`/`name` so an invalid entry stays human-legible in the list; `null`
 * when the shallow parse cannot recover either field. */
function shallowIdentity(absPath: string): { id: string | null; name: string | null } {
  try {
    const raw = JSON.parse(readFileSync(absPath, "utf8")) as Record<string, unknown>;
    return {
      id: typeof raw.id === "string" ? raw.id : null,
      name: typeof raw.name === "string" ? raw.name : null,
    };
  } catch {
    return { id: null, name: null };
  }
}

// The workflow store: the path-addressed door onto workflow files, as the template store is the
// id-addressed door onto templates. Both ask the requester's write access which files a door may
// change (ADR 0088).

export type WorkflowWrite =
  | { ok: true; relativePath: string; id: string; etag: string; created: boolean }
  | ({ ok: false; status: 400 | 403 | 404 | 412; details?: Message[] } & Refusal);

export type WorkflowRemove =
  | { ok: true }
  | ({ ok: false; status: 400 | 403 | 404 | 409 | 412 } & Refusal);

export interface WorkflowStore {
  /** The requester's workflow Discovery: every row it may see, and the roots it may write. */
  list(): Promise<ListWorkflowsResponse>;
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
    /** Discover every workflow in the user, shared and shipped roots (ADR 0085, ADR 0086). A file
     * that loaded is `is_root: false` exactly when some valid root referenced it, `true` otherwise;
     * a file that failed to load carries `is_root: null` (no ref set) and its coded error. */
    async list() {
      const { layout } = access;
      const scanned = layout.files("workflow");
      const loaded = await Promise.all(
        scanned.map(async ({ absPath, root }) => ({
          absPath,
          root,
          result: await loadAuthoredWorkflow(layout, absPath),
        })),
      );

      // A discovered file reachable as a *valid* root's nested ref.
      const referenced = new Set<string>();
      for (const { absPath, result } of loaded) {
        if (!result.success) continue;
        for (const key of result.workflow.files.keys()) {
          if (key !== absPath) referenced.add(key);
        }
      }

      const workflows: WorkflowSummary[] = loaded.map(({ absPath, root, result }) => {
        // A writable row is named by its project path, the launch and open handle; a shipped row by
        // its path in the shipped root, the handle Copy takes.
        const rootPath = relative(root.dir, absPath);
        const place = {
          relative_path: root.writable ? relative(layout.projectDir, absPath) : rootPath,
          origin: root.origin,
          root_path: rootPath,
          action: root.writable ? "open" : result.success ? "copy" : "none",
          read_only: access.readOnly({ absPath, root }),
        } as const;
        if (result.success) {
          const file = result.workflow.rootFile;
          return {
            ...place,
            id: file.id,
            name: file.name,
            valid: true,
            is_root: !referenced.has(absPath),
            error: null,
          };
        }
        const { id, name } = shallowIdentity(absPath);
        return {
          ...place,
          id,
          name,
          valid: false,
          is_root: null,
          error: wireError("workflow.invalid", {}, result.issues, firstText(result.issues)),
        };
      });

      const roots = writableRoots(layout, "workflow");
      return { workflows, roots, max_file_bytes: access.maxFileBytes ?? null };
    },

    write(workflowPath, payload, ifMatch) {
      // Path and access (404, 403) before schema (400): a path the requester may not change is
      // refused regardless of the payload. The write's own limits come after the schema.
      const target = access.workflow(workflowPath);
      if (!target.ok) return target;
      const { absPath } = target;

      // Parsed against the registry frozen at server start (ADR 0018), like every other door that
      // validates a file.
      const validation = safeParseWorkflowFile(payload, stepPlugins);
      if (!validation.success) {
        return {
          ok: false,
          status: 400,
          code: "workflow.invalid",
          details: validation.issues,
        };
      }
      const duplicates = duplicateIdIssues(validation.data);
      if (duplicates.length > 0) {
        return {
          ok: false,
          status: 400,
          code: "workflow.invalid",
          details: duplicates,
        };
      }
      const written = access.write(absPath, "workflow", payload, {
        ifMatch,
        rule: "create-or-overwrite",
      });
      if (!written.ok) return written;
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
        return { ok: false, status: 404, code: "request.not-found" };
      }
      // The lease first: another session editing the file outranks a stale token, and either way
      // the file is untouched.
      if (lease.heldByOther(sessionId)) {
        return { ok: false, status: 409, code: "lease.held" };
      }
      const removed = conditionalDelete(target.absPath, ifMatch);
      if (!removed.ok) {
        // A file that is already gone is the `404`; a missing or stale token is the `412`.
        return removed.conflict === "missing"
          ? { ok: false, status: 404, code: "request.not-found" }
          : { ok: false, status: 412, code: PRECONDITION_FAILED[removed.conflict] };
      }
      lease.remove();
      access.removed(workflowPath, "workflow");
      return { ok: true };
    },
  };
}
