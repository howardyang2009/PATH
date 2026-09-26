import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadWorkflowTree, type LoadedWorkflow } from "@path/engine";
import { mapEnv, type ConfigObject, type JsonValue, type RunRecord } from "@path/schema";
import { confineToProjectRoot } from "./confine.js";

/**
 * Turning a workflow path into a launchable workflow, once, for every surface that needs one.
 *
 * **What this module exists to own.** `POST /v0/runs` (§2) and `POST /v0/runs/:root_run_id/resume`
 * (§4.3) both reach a run the same way: reject operator config that sources from the server
 * environment (ADR 0012), reject a path that escapes the project root, 404 a file that is not
 * there, 400 a file that no longer validates, and otherwise load it. That preamble was spelled twice
 * — and the copies had already drifted: `resume-run.ts` called {@link operatorConfigEnvError} while
 * `post-runs.ts` carried its own inline `mapEnv` walk of the same rule. A third launch surface would
 * have inherited neither.
 *
 * On top of that gate sit the actions on a run that already exists — Resume and Complete — which must
 * first recover the workflow from the run's own row and confirm it is still the same workflow;
 * {@link prepareRunWorkflow} owns that, one step above {@link prepareWorkflow}.
 *
 * What stays with a route is what legitimately differs: the request body schema it parses, the
 * *source* of the workflow path (a request field for a fresh launch, the predecessor's recorded row
 * for a run action), and how a refusal reads to that caller — which is why the message hooks are the
 * one hole through these functions. Resume's extra pre-load policy (the run must be finished and
 * unsuccessful) stays in the route too.
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
 * - escapes the project root, or traverses a symlink → `404`, `messages.escapesRoot` (defaulting to
 *   `notFound`). `workflow_path` resolves against the fixed project root the way `path run
 *   <workflow.json>` resolves against the cwd (server-api-v0.md §2), through the same confinement as
 *   every other file door (`confine.ts`): the server, unlike the CLI, is not trusted with the
 *   operator's whole filesystem;
 * - not on disk → `404`, `messages.notFound`;
 * - fails to load → `400`, `"workflow validation failed"` with the loader's per-file errors.
 *
 * The `$env` reject is a separate call ({@link operatorConfigEnvError}) a route makes first, because
 * it is about the config and not the path — and both routes reject a bad config before ever touching
 * the filesystem.
 */
export async function prepareWorkflow(
  projectDir: string,
  workflowPath: string,
  messages: NotFoundMessages,
): Promise<PreparedWorkflow> {
  // A missing tail is allowed through here so that a file that is simply not there reads as
  // `notFound` below rather than as an escape.
  const absPath = confineToProjectRoot(resolve(projectDir), workflowPath, { allowMissingTail: true });
  if (!absPath) {
    const escaped = (messages.escapesRoot ?? messages.notFound)(workflowPath);
    return { ok: false, refusal: { status: 404, message: escaped } };
  }
  if (!existsSync(absPath)) {
    return { ok: false, refusal: { status: 404, message: messages.notFound(workflowPath) } };
  }

  const loadResult = await loadWorkflowTree(absPath);
  if (!loadResult.success) {
    return { ok: false, refusal: { status: 400, message: "workflow validation failed", details: loadResult.errors } };
  }
  return { ok: true, workflow: loadResult.workflow };
}

/**
 * The two refusals an action on an existing run owns beyond the path gate: a root row recorded
 * without a path (pre-#169) has no file to recover, and a file at the recorded path that is no longer
 * the workflow this run ran is the wrong file to act on (identity is the id, ADR 0006).
 */
export interface RunWorkflowMessages extends NotFoundMessages {
  /** The run's own root row records no workflow path. */
  noPath(): string;
  /** The file at the recorded path is no longer the workflow this run ran. */
  swapped(workflowPath: string): string;
}

/**
 * The **current authoring of the workflow an existing run was launched from**: recover the
 * store-relative path from the run's own root row, run the same escape / not-found / invalid gate a
 * fresh launch runs ({@link prepareWorkflow}), and confirm the file is still the *same workflow* by
 * id (ADR 0006) — a different workflow swapped in at that path would otherwise be driven against the
 * predecessor's restored context, or completed with its node ids alone as the only match.
 *
 * Every action on an existing run asks this one question — Resume (§4.3) and Complete (§4.4) today —
 * and it is the piece that had drifted: `resume-run.ts` checked the workflow id while
 * `complete-run.ts` did not, so Complete alone would accept a swapped file whose node ids happened to
 * line up. The route keeps its own policy: the action verb in a refusal, and rendering the status.
 *
 * A predecessor that recorded no id (a run from before the column existed) skips the identity check
 * rather than refusing on `undefined`; every run since #169 records one.
 */
export async function prepareRunWorkflow(
  projectDir: string,
  root: Pick<RunRecord, "workflowId" | "workflowPath">,
  messages: RunWorkflowMessages,
): Promise<PreparedWorkflow> {
  if (!root.workflowPath) {
    return { ok: false, refusal: { status: 409, message: messages.noPath() } };
  }
  const prepared = await prepareWorkflow(projectDir, root.workflowPath, messages);
  if (!prepared.ok) return prepared;
  if (root.workflowId && prepared.workflow.rootFile.id !== root.workflowId) {
    return { ok: false, refusal: { status: 409, message: messages.swapped(root.workflowPath) } };
  }
  return prepared;
}
