import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { loadWorkflowTree, type LoadedWorkflow } from "@path/engine";
import { mapEnv, type ConfigObject, type JsonValue } from "@path/schema";

/**
 * Turning a workflow path into a launchable workflow, once, for both launch surfaces.
 *
 * **What this module exists to own.** `POST /v0/runs` (§2) and `POST /v0/runs/:root_run_id/resume`
 * (§4.3) both reach a run the same way: reject operator config that sources from the server
 * environment (ADR 0012), reject a path that escapes the project root, 404 a file that is not
 * there, 400 a file that no longer validates, and otherwise load it. That preamble was spelled twice
 * — and the copies had already drifted: `resume-run.ts` called {@link operatorConfigEnvError} while
 * `post-runs.ts` carried its own inline `mapEnv` walk of the same rule. A third launch surface would
 * have inherited neither.
 *
 * What stays with a route is what legitimately differs: the request body schema it parses, the
 * *source* of the workflow path (a request field for a fresh launch, the predecessor's recorded row
 * for a resume), and how a missing file reads to that caller — which is why `notFound` is the one
 * hole in {@link prepareWorkflow}. Resume's extra pre-load refusals (the run must be finished,
 * unsuccessful, and still name the same workflow) are resume policy, not launch preparation, so they
 * stay in the route too.
 */

/** A ready-to-send refusal: `sendError(res, status, message, details)` and return. */
export interface WorkflowRefusal {
  status: number;
  message: string;
  /** The loader's per-file errors on a 400 validation failure; absent otherwise. */
  details?: string[];
}

export type PreparedWorkflow =
  | { ok: true; workflow: LoadedWorkflow }
  | { ok: false; refusal: WorkflowRefusal };

/**
 * `workflow_path` resolves against the server's fixed project root, the same way `path run
 * <workflow.json>` resolves against the cwd (server-api-v0.md §2) — except a path that escapes the
 * project root yields `undefined` rather than being followed, since the server (unlike the CLI) is
 * not trusted with the operator's whole filesystem.
 */
function resolveWorkflowPath(projectDir: string, workflowPath: string): string | undefined {
  const absPath = resolve(projectDir, workflowPath);
  const rel = relative(projectDir, absPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return absPath;
}

/**
 * The ADR 0012 `$env` reject both launch endpoints owe: operator-supplied override config may name a
 * literal `{"$secret": "..."}` but not `{"$env": "NAME"}` — an `$env` would source a config value
 * from the *server process* environment and read it back through a step's output. `ConfigObjectSchema`
 * is shared with workflow-authored config (where `$env` is legitimate), so the reject cannot live in
 * the schema; it is this post-parse walk on the operator path only.
 *
 * Returns a ready-to-send `400` message naming every offending dot-path, or `undefined` when the
 * config is clean. `mapEnv` descends *through* a `$secret` wrapper, so the composed
 * `{"$secret": {"$env": "NAME"}}` form is caught and reported at the config key (not `key.$secret`).
 */
export function operatorConfigEnvError(config: ConfigObject): string | undefined {
  const paths: string[] = [];
  mapEnv(config as JsonValue, (_name, path) => {
    paths.push(path);
    return null;
  });
  if (paths.length === 0) return undefined;
  return `operator config may not source from the server environment: $env at ${paths.map((p) => `"${p}"`).join(", ")}`;
}

/** How a route words its two 404s — the only wording that legitimately differs between the surfaces. */
export interface NotFoundMessages {
  /** A path on disk that isn't there. A fresh launch names the path sent; a resume names the run. */
  notFound(workflowPath: string): string;
  /**
   * A path that escapes the project root. Defaults to {@link NotFoundMessages.notFound}: a fresh
   * launch distinguishes the two (an escaping `workflow_path` is a distinct operator mistake), while
   * a resume folds them — its path comes from a row this server wrote relative to the root, so an
   * escape is unreachable and shares the "recorded file is gone" 404 rather than earning its own.
   */
  escapesRoot?(workflowPath: string): string;
}

/**
 * Resolve a workflow path within the project root, confirm the file exists, and load + validate it —
 * returning the {@link LoadedWorkflow} or a ready-to-send refusal. The three refusals mirror the two
 * routes' existing wording and status codes:
 *
 * - escapes the project root → `404`, `messages.escapesRoot` (defaulting to `notFound`);
 * - not on disk → `404`, `messages.notFound`;
 * - fails to load → `400`, `"workflow validation failed"` with the loader's per-file errors.
 *
 * The `$env` reject is a separate call ({@link operatorConfigEnvError}) a route makes first, because
 * it is about the config and not the path — and both routes reject a bad config before ever touching
 * the filesystem.
 */
export function prepareWorkflow(
  projectDir: string,
  workflowPath: string,
  messages: NotFoundMessages,
): PreparedWorkflow {
  const absPath = resolveWorkflowPath(projectDir, workflowPath);
  if (!absPath) {
    const escaped = (messages.escapesRoot ?? messages.notFound)(workflowPath);
    return { ok: false, refusal: { status: 404, message: escaped } };
  }
  if (!existsSync(absPath)) {
    return { ok: false, refusal: { status: 404, message: messages.notFound(workflowPath) } };
  }

  const loadResult = loadWorkflowTree(absPath);
  if (!loadResult.success) {
    return { ok: false, refusal: { status: 400, message: "workflow validation failed", details: loadResult.errors } };
  }
  return { ok: true, workflow: loadResult.workflow };
}
