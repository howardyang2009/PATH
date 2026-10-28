import { existsSync } from "node:fs";
import { type LoadedWorkflow, loadWorkflowTree } from "@path/engine";
import type { Message } from "@path/i18n";
import { type ConfigObject, type JsonValue, mapEnv, type RunRecord } from "@path/schema";
import type { AuthoredLayout } from "./authored-layout.js";
import { confineToProjectRoot } from "./confine.js";
import type { Refusal } from "./http-json.js";

/**
 * Turning a workflow path into a launchable workflow, once, for every launch surface: reject
 * operator config sourcing `$env`, reject an escaping path, 404 a missing file, 400 a file that no
 * longer validates.
 */

export interface WorkflowRefusal extends Refusal {
  status: number;
  details?: Message[];
}

export type PreparedWorkflow =
  | { ok: true; workflow: LoadedWorkflow }
  | { ok: false; refusal: WorkflowRefusal };

/** ADR 0012: operator config may name a literal `$secret` but not `$env`, which would source from
 * the server process environment; `ConfigObjectSchema` is shared with workflow config, where `$env`
 * is legal. */
export function operatorConfigEnvError(config: ConfigObject): Refusal | undefined {
  const paths: string[] = [];
  mapEnv(config as JsonValue, (_name, path) => {
    paths.push(path);
    return null;
  });
  if (paths.length === 0) return undefined;
  return { code: "run.config-env", params: { paths: paths.map((p) => `"${p}"`).join(", ") } };
}

/** How a route words its two 404s — the only wording that legitimately differs between the
 * surfaces. */
export interface NotFoundMessages {
  notFound(workflowPath: string): Refusal;
  escapesRoot?(workflowPath: string): Refusal;
}

/** Resolve a path within the project root, confirm it may run and exists, then load and validate
 * it. 404 when it escapes or is missing, 403 for a shipped file, 400 when it fails to load; a
 * missing tail reads as `notFound`, not an escape. */
export async function prepareWorkflow(
  layout: AuthoredLayout,
  workflowPath: string,
  messages: NotFoundMessages,
): Promise<PreparedWorkflow> {
  // Another user's path reads as missing, so a refusal never confirms that it exists.
  if (!layout.inView(workflowPath)) {
    return { ok: false, refusal: { status: 404, ...messages.notFound(workflowPath) } };
  }
  const absPath = confineToProjectRoot(layout.projectDir, workflowPath, {
    allowMissingTail: true,
  });
  if (!absPath) {
    const escaped = (messages.escapesRoot ?? messages.notFound)(workflowPath);
    return { ok: false, refusal: { status: 404, ...escaped } };
  }
  const refusal = layout.workflowRefusal(workflowPath, "run");
  if (refusal !== undefined) return { ok: false, refusal };
  if (!existsSync(absPath)) {
    return { ok: false, refusal: { status: 404, ...messages.notFound(workflowPath) } };
  }

  const loadResult = await loadWorkflowTree(absPath, { refAllowed: layout.inView });
  if (!loadResult.success) {
    return {
      ok: false,
      refusal: { status: 400, code: "workflow.invalid", details: loadResult.issues },
    };
  }
  return { ok: true, workflow: loadResult.workflow };
}

/** The two refusals an action on an existing run owns beyond the path gate (ADR 0006 identity). */
export interface RunWorkflowMessages extends NotFoundMessages {
  /** The reply for a run whose workflow lies outside the requester's view: an unknown run. */
  noRun(): Refusal;
  noPath(): Refusal;
  swapped(workflowPath: string): Refusal;
}

/** The **current authoring** of the workflow an existing run was launched from: recover the
 * store-relative path from the run's root row, run the same escape/not-found/invalid gate, and
 * confirm it is still the same workflow by id (ADR 0006); a predecessor with no recorded id skips
 * that check. */
export async function prepareRunWorkflow(
  layout: AuthoredLayout,
  root: Pick<RunRecord, "workflowId" | "workflowPath">,
  messages: RunWorkflowMessages,
): Promise<PreparedWorkflow> {
  if (!root.workflowPath) {
    return { ok: false, refusal: { status: 409, ...messages.noPath() } };
  }
  if (!layout.inView(root.workflowPath)) {
    return { ok: false, refusal: { status: 404, ...messages.noRun() } };
  }
  const prepared = await prepareWorkflow(layout, root.workflowPath, messages);
  if (!prepared.ok) return prepared;
  if (root.workflowId && prepared.workflow.rootFile.id !== root.workflowId) {
    return { ok: false, refusal: { status: 409, ...messages.swapped(root.workflowPath) } };
  }
  return prepared;
}
