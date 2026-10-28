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

/** An action on an existing run: which door asks, and the ids its refusals name. */
export type RunAction =
  | { kind: "resume"; rootRunId: string }
  | { kind: "complete"; rootRunId: string; stepRunId: string };

/** Resolve a path within the project root, confirm it may run and exists, then load and validate
 * it. 404 when it escapes or is missing, 403 for a shipped file, 400 when it fails to load; a
 * missing tail reads as `notFound`, not an escape. */
async function loadInView(
  layout: AuthoredLayout,
  workflowPath: string,
  notFound: Refusal,
  escapesRoot: Refusal,
): Promise<PreparedWorkflow> {
  // Another user's path reads as missing, so a refusal never confirms that it exists.
  if (!layout.inView(workflowPath)) return { ok: false, refusal: { status: 404, ...notFound } };
  const absPath = confineToProjectRoot(layout.projectDir, workflowPath, {
    allowMissingTail: true,
  });
  if (!absPath) return { ok: false, refusal: { status: 404, ...escapesRoot } };
  const refusal = layout.workflowRefusal(workflowPath, "run");
  if (refusal !== undefined) return { ok: false, refusal };
  if (!existsSync(absPath)) return { ok: false, refusal: { status: 404, ...notFound } };

  const loadResult = await loadWorkflowTree(absPath, { refAllowed: layout.inView });
  if (!loadResult.success) {
    return {
      ok: false,
      refusal: { status: 400, code: "workflow.invalid", details: loadResult.issues },
    };
  }
  return { ok: true, workflow: loadResult.workflow };
}

/** The workflow a launch (`POST /v0/runs`) names, through the path gate. */
export function prepareLaunch(
  layout: AuthoredLayout,
  workflowPath: string,
): Promise<PreparedWorkflow> {
  const params = { workflowPath };
  return loadInView(
    layout,
    workflowPath,
    { code: "workflow.not-found", params },
    { code: "workflow.escapes-root", params },
  );
}

/** The **current authoring** of the workflow an existing run was launched from: recover the
 * store-relative path from the run's root row, run the same path gate, and confirm it is still the
 * same workflow by id (ADR 0006); a predecessor with no recorded id skips that check. Each refusal
 * is named for `action`'s door. */
export async function prepareRunWorkflow(
  layout: AuthoredLayout,
  root: Pick<RunRecord, "workflowId" | "workflowPath">,
  action: RunAction,
): Promise<PreparedWorkflow> {
  const { kind, rootRunId } = action;
  const workflowPath = root.workflowPath;
  if (!workflowPath) {
    return {
      ok: false,
      refusal: { status: 409, code: `run.${kind}.no-path`, params: { rootRunId } },
    };
  }
  // A run whose workflow lies outside the requester's view reads as an unknown run.
  if (!layout.inView(workflowPath)) {
    const noRun: Refusal =
      action.kind === "resume"
        ? { code: "run.not-found", params: { rootRunId } }
        : { code: "run.step-not-found", params: { stepRunId: action.stepRunId } };
    return { ok: false, refusal: { status: 404, ...noRun } };
  }
  // The path came from our own row, so an escape reads as missing too.
  const missing: Refusal = { code: "run.workflow-missing", params: { rootRunId, workflowPath } };
  const prepared = await loadInView(layout, workflowPath, missing, missing);
  if (!prepared.ok) return prepared;
  if (root.workflowId && prepared.workflow.rootFile.id !== root.workflowId) {
    return {
      ok: false,
      refusal: { status: 409, code: `run.${kind}.swapped`, params: { workflowPath, rootRunId } },
    };
  }
  return prepared;
}
