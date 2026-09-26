import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type LoadedWorkflow, loadWorkflowTree } from "@path/engine";
import { type ConfigObject, type JsonValue, mapEnv, type RunRecord } from "@path/schema";
import { confineToProjectRoot } from "./confine.js";

/**
 * Turning a workflow path into a launchable workflow, once, for every launch surface: reject operator
 * config sourcing `$env`, reject an escaping path, 404 a missing file, 400 a file that no longer validates.
 */

export interface WorkflowRefusal {
  status: number;
  message: string;
  details?: string[];
}

export type PreparedWorkflow =
  | { ok: true; workflow: LoadedWorkflow }
  | { ok: false; refusal: WorkflowRefusal };

/** ADR 0012: operator config may name a literal `$secret` but not `$env`, which would source from the
 * server process environment; `ConfigObjectSchema` is shared with workflow config, where `$env` is legal. */
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
  notFound(workflowPath: string): string;
  escapesRoot?(workflowPath: string): string;
}

/** Resolve a path within the project root, confirm it exists, then load and validate it. 404 when it
 * escapes or is missing, 400 when it fails to load; a missing tail reads as `notFound`, not an escape. */
export async function prepareWorkflow(
  projectDir: string,
  workflowPath: string,
  messages: NotFoundMessages,
): Promise<PreparedWorkflow> {
  const absPath = confineToProjectRoot(resolve(projectDir), workflowPath, {
    allowMissingTail: true,
  });
  if (!absPath) {
    const escaped = (messages.escapesRoot ?? messages.notFound)(workflowPath);
    return { ok: false, refusal: { status: 404, message: escaped } };
  }
  if (!existsSync(absPath)) {
    return { ok: false, refusal: { status: 404, message: messages.notFound(workflowPath) } };
  }

  const loadResult = await loadWorkflowTree(absPath);
  if (!loadResult.success) {
    return {
      ok: false,
      refusal: { status: 400, message: "workflow validation failed", details: loadResult.errors },
    };
  }
  return { ok: true, workflow: loadResult.workflow };
}

/** The two refusals an action on an existing run owns beyond the path gate (ADR 0006 identity). */
export interface RunWorkflowMessages extends NotFoundMessages {
  noPath(): string;
  swapped(workflowPath: string): string;
}

/** The **current authoring** of the workflow an existing run was launched from: recover the store-relative
 * path from the run's root row, run the same escape/not-found/invalid gate, and confirm it is still the
 * same workflow by id (ADR 0006); a predecessor with no recorded id skips that check. */
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
