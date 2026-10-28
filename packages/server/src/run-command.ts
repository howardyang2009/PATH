import type { LoadedWorkflow, LogBackendId } from "@path/engine";
import type { ConfigObject, JsonValue } from "@path/schema";
import { launchInput, validateLaunchWorkerDefaults } from "@path/schema";
import type { Refusal } from "./http-json.js";
import { operatorConfigEnvError, prepareLaunch, prepareRunWorkflow } from "./launch.js";
import type { ResumeOutcome, StartedRun } from "./live-runs.js";
import { resolveLeaf, resolveRun } from "./routes/resolve-run.js";
import type { RouteContext } from "./routes/route-context.js";

/**
 * The one command every run door sends: start a workflow, resume a root run, or complete a parked
 * leaf. The door parses the body; this module owns everything after it — the operator-config `$env`
 * reject (ADR 0012), the path gate, the one seams record handed to the live runs, and the HTTP
 * status a refusal answers with (ADR 0094). A door that adds a run action adds an arm here.
 */

export type RunCommand =
  | {
      kind: "start";
      workflowPath: string;
      input?: { [key: string]: JsonValue };
      config?: ConfigObject;
      launchWorkerDefaults?: { [type: string]: string };
      logBackends?: LogBackendId[];
      processorConcurrency?: number;
    }
  | { kind: "resume"; rootRunId: string; config?: ConfigObject; rerunFromRunId?: string }
  | { kind: "complete"; stepRunId: string; output: JsonValue; config?: ConfigObject };

/** A command that started or continued a run, or the refusal a door replies. */
export type RunCommandOutcome = ({ ok: true } & StartedRun) | { ok: false; refusal: Refusal };

/** Run one command: the `400`/`404`/`409` refusals carry their status; only a genuine start
 * failure answers `500`. */
export async function runCommand(
  command: RunCommand,
  ctx: RouteContext,
): Promise<RunCommandOutcome> {
  switch (command.kind) {
    case "start":
      return start(command, ctx);
    case "resume":
      return resume(command, ctx);
    case "complete":
      return complete(command, ctx);
  }
}

function envRefusal(config: ConfigObject | undefined): Refusal | undefined {
  return config === undefined ? undefined : operatorConfigEnvError(config);
}

/** The one record every arm hands the live runs: the workflow's files and the registry it was
 * validated against (ADR 0019 sub-15), plus the secrets read again at this call (ADR 0089). */
function seams(workflow: LoadedWorkflow, ctx: RouteContext) {
  return {
    files: workflow.files,
    registry: workflow.registry,
    userSecrets: ctx.secrets?.values(),
  };
}

async function start(
  command: Extract<RunCommand, { kind: "start" }>,
  ctx: RouteContext,
): Promise<RunCommandOutcome> {
  const refusal = envRefusal(command.config);
  if (refusal !== undefined) return { ok: false, refusal };

  const prepared = await prepareLaunch(ctx.layout, command.workflowPath);
  if (!prepared.ok) return { ok: false, refusal: prepared.refusal };
  const { workflow } = prepared;

  // The launch channel of ADR 0044's registry-relative validation: `worker_defaults` is operator
  // input, authored in no file, so a bad entry is a `400` before the run starts, every bad entry in
  // one pass.
  const workerDefaultErrors = validateLaunchWorkerDefaults(
    command.launchWorkerDefaults,
    workflow.registry,
  ).map((message) => `worker_defaults: ${message}`);
  if (workerDefaultErrors.length > 0) {
    return {
      ok: false,
      refusal: replyRefusalOf(400, "run.invalid-worker-defaults", {}, workerDefaultErrors),
    };
  }

  try {
    const ids = await ctx.live.start(workflow.rootFile, workflow.workflowDir, {
      // The effective root input and recorded override, by the one rule every launch door shares
      // (format @4 §1a, ADR 0046).
      ...launchInput(command.input, workflow.rootFile.input),
      operatorConfig: command.config,
      launchWorkerDefaults: command.launchWorkerDefaults,
      ...seams(workflow, ctx),
      logBackends: command.logBackends,
      processorConcurrency: command.processorConcurrency,
      // Recorded on the root row so this run is resumable (§4.3), relative to the project root
      // whichever store holds the run.
      sourceWorkflowPath: workflow.storeRelativePath(ctx.layout.projectDir),
    });
    return { ok: true, ...ids };
  } catch (err) {
    return { ok: false, refusal: failure(500, "run.start-failed", err) };
  }
}

async function resume(
  command: Extract<RunCommand, { kind: "resume" }>,
  ctx: RouteContext,
): Promise<RunCommandOutcome> {
  const refusal = envRefusal(command.config);
  if (refusal !== undefined) return { ok: false, refusal };

  // The predecessor's root row — never another row whose status could disagree with the root's.
  const address = resolveRun(ctx, command.rootRunId);
  if (!address.ok) return { ok: false, refusal: address };

  const prepared = await prepareRunWorkflow(ctx.layout, address.root, {
    kind: "resume",
    rootRunId: command.rootRunId,
  });
  if (!prepared.ok) return { ok: false, refusal: prepared.refusal };
  const { workflow } = prepared;

  let resumed: ResumeOutcome;
  try {
    resumed = await ctx.live.resume(workflow.rootFile, command.rootRunId, workflow.workflowDir, {
      ...seams(workflow, ctx),
      operatorConfig: command.config,
      sourceWorkflowPath: workflow.storeRelativePath(ctx.layout.projectDir),
      // The rerun boundary K, forwarded verbatim: the route does no K-logic; `Project.resume`
      // validates.
      rerunFromRunId: command.rerunFromRunId,
    });
  } catch (err) {
    return { ok: false, refusal: failure(500, "run.resume.start-failed", err) };
  }
  if (!resumed.ok) return { ok: false, refusal: resumed.refusal };
  return { ok: true, runId: resumed.runId, rootRunId: resumed.rootRunId };
}

async function complete(
  command: Extract<RunCommand, { kind: "complete" }>,
  ctx: RouteContext,
): Promise<RunCommandOutcome> {
  const refusal = envRefusal(command.config);
  if (refusal !== undefined) return { ok: false, refusal };

  // Resolve the leaf's tree from one read; unknown id is a 404 before any file work.
  const address = resolveLeaf(ctx, command.stepRunId);
  if (!address.ok) return { ok: false, refusal: address };
  const { rootRunId, leaf } = address;

  // The compare half of the leaf CAS, checked before reload/lease so an ordinary double-submit
  // never contends. The engine repeats it under the lease to close the concurrent-submit race.
  if (leaf.status !== "awaiting") {
    return {
      ok: false,
      refusal: replyRefusalOf(409, "run.complete.not-awaiting", {
        stepRunId: command.stepRunId,
        status: leaf.status,
      }),
    };
  }
  if (!address.root) {
    return { ok: false, refusal: replyRefusalOf(409, "run.complete.no-path", { rootRunId }) };
  }

  // Recover and re-validate the workflow as it stands now: the node lookup below must be a lookup
  // in *this run's* file (matching id, ADR 0006), not merely one sharing the node's id.
  const prepared = await prepareRunWorkflow(ctx.layout, address.root, {
    kind: "complete",
    rootRunId,
    stepRunId: command.stepRunId,
  });
  if (!prepared.ok) return { ok: false, refusal: prepared.refusal };
  const { workflow } = prepared;

  const result = await ctx.live.complete(
    workflow.rootFile,
    rootRunId,
    command.stepRunId,
    command.output,
    workflow.workflowDir,
    {
      ...seams(workflow, ctx),
      operatorConfig: command.config,
    },
  );

  if (!result.ok) {
    // `not-found` → 404; `output-invalid` → 400 with issues; the rest are 409 state conflicts.
    if (result.reason === "output-invalid") {
      return { ok: false, refusal: { ...result, status: 400 } };
    }
    return {
      ok: false,
      refusal: { ...result, status: result.reason === "not-found" ? 404 : 409 },
    };
  }
  return { ok: true, runId: command.stepRunId, rootRunId: result.rootRunId };
}

/** A refusal whose status a door decided rather than a store. */
function replyRefusalOf(
  status: number,
  code: Refusal["code"],
  params: Refusal["params"] = {},
  details?: unknown,
): Refusal {
  return {
    status,
    code,
    params,
    ...(details === undefined ? {} : { details }),
  };
}

/** A genuine failure to start: the engine or the executor threw before any run existed. */
function failure(status: number, code: Refusal["code"], err: unknown): Refusal {
  return replyRefusalOf(status, code, {
    message: err instanceof Error ? err.message : String(err),
  });
}
