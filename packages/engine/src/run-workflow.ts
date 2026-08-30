import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { formatIssues, mapSecrets, walkNodes, type BranchNode, type CheckpointNode, type ConfigObject, type ConfigValue, type JsonValue, type RunRecord, type WhileDoNode, type WorkflowFile } from "@path/schema";
import { z } from "zod";
import { findNestedCounterpart, planReuse } from "./plan-reuse.js";
import { runParallelNode, settleDetached } from "./run-parallel.js";
import { RUN_BLOB_FILE } from "./persistence/paths.js";
import { describeConditionFailure, evaluateCondition, type Trace } from "./condition.js";
import {
  type Cancellation,
  type Emit,
  type StepRuntime,
  type NodeExecContext,
  type RunContext,
  type RunIdentity,
  type RunResume,
  type SeqOutcome,
} from "./run-context.js";
import { createEmitter, type Emitter, type StepEmitter } from "./run-emitter.js";
import { InterpolationError, interpolateToString, interpolateValue, type InterpolationScope } from "./interpolate.js";
import { scanStepPlugins, type LoadedStepPluginRegistry } from "./plugin/scan.js";
import type { StepRequest, StepResult, WorkerDescriptor } from "./plugin/seam.js";
import { createProcessorSemaphore, DEFAULT_PROCESSOR_CONCURRENCY } from "./processor-semaphore.js";
import { mergeConfig } from "./merge-config.js";
import { OutputParseError, parseStepOutput } from "./parse-output.js";
import { describeUnsetEnv, type EnvSource, resolveConfigEnv, resolveRunEnv } from "./resolve-env.js";
import { ObserverError, type RunObserver } from "./run-observer.js";
import { collectSecrets, maskObservation } from "./secret-mask.js";

/**
 * Test/host worker overrides (ADR 0021 sub-15): a `(type, worker-name)` map of replacement
 * descriptors, merged over the scanned registry replace-only. Every named pair must already exist in
 * the scanned registry — the map cannot add a type or a worker name, only swap a shipped worker's
 * `run`/flags for a substitute.
 */
export type WorkerOverrides = { [type: string]: { [name: string]: WorkerDescriptor } };

export interface RunOptions {
  /** The workflow's own input object (format doc §6.1); its top-level keys seed context (§6.3). */
  input?: { [key: string]: JsonValue };
  /** Operator launch-time config (CLI flags/file), overriding the top-level file's defaults (spec §3). */
  operatorConfig?: ConfigObject;
  /**
   * Every workflow file reachable from the root via `workflow` step refs, keyed by absolute path —
   * `loadWorkflowTree`'s output (#16). A `workflow` step resolves its `ref` against this map to
   * run the child file (#22); omitted when the workflow has no `workflow` steps.
   */
  files?: Map<string, WorkflowFile>;
  /** The audit seam: one observer receiving every observation of this run tree (see run-observer.ts). */
  observer?: RunObserver;
  /**
   * Load-time diagnostics that aren't run failures — currently the short-secret warning (#20).
   * The engine has no I/O of its own, so the caller (the CLI) decides where these surface.
   */
  warn?: (message: string) => void;
  /**
   * Replace named `(type, worker)` pairs in the scanned registry before dispatch (ADR 0021 sub-15).
   * The shape is `{ [type]: { [name]: WorkerDescriptor } }`, merged over the frozen registry inside
   * `runWorkflow` **replace-only**: an override naming a `(type, name)` pair the scan did not produce
   * is a hard error, never an insertion — the registry's name set stays owned by the folder scan (ADR
   * 0019 sub-2). The acceptance run's scripted `prompt`/`sdk` worker plugs in here; a live run passes
   * nothing and every leaf runs on its shipped worker.
   */
  workerOverrides?: WorkerOverrides;
  /**
   * The frozen step-plugin registry this run dispatches against — the one `loadWorkflowTree` scanned
   * to build the schema that validated the file (ADR 0019 sub-15, `LoadedWorkflow.registry`). Threaded
   * in so the file executes against **exactly** the registry it was validated against: one scan of the
   * folder per run, and no window in which an edit between load and run makes the two disagree. The
   * production path (`cli.ts`, the server routes) always sets it.
   *
   * A caller that reaches `runWorkflow` without a load — a test that builds a `WorkflowFile` in memory,
   * or an embedder — omits it, and the run scans the folder itself (`scanStepPlugins`) as the
   * fallback. `workerOverrides` still merges over whichever registry results, replace-only.
   */
  registry?: LoadedStepPluginRegistry;
  /**
   * Where the self-scan fallback looks for step-type plugins (ADR 0019 sub-8), defaulting to the one
   * fixed `STEP_PLUGINS_DIR`. Consulted **only when `registry` is absent** — a live run passes the
   * loaded registry and never reaches the scan, so it never sets this. It exists for a test that must
   * exercise the *scanned* registry over a fixture plugin folder rather than a hand-built one (ADR 0020
   * sub-10): the scan, dispatch, and masking choke point are the real ones, only the directory differs.
   */
  stepPluginsDir?: string;
  /**
   * The engine-wide cap on concurrent Processors (mvp spec §5.5) — default 4. One semaphore
   * covers the whole run tree, so nested workflows and nested parallels share it.
   */
  processorConcurrency?: number;
  /**
   * External abort (#52): the way an operator stops this root run in flight. Aborting it kills the
   * in-flight leaf steps of the whole run tree best-effort — a binary step's child process, an LLM
   * step's processor — and the root run ends `cancelled` rather than dying mid-step or being left as
   * a lying `running` row. A signal that is already aborted when `runWorkflow` is called cancels the
   * run before its first step.
   *
   * Best-effort, not guaranteed (mvp spec §5.6): cancellation asks, and the engine holds no deadline
   * and no force path. Cancellation is per **root run** — there is no per-run controller registry.
   */
  signal?: AbortSignal;
  /**
   * Resume a prior tree (#172): reuse the recorded work of every succeeded run whose node id still
   * matches (#170's `planReuse`), and restore each re-entered workflow-run's context blackboard from
   * the original tree, rather than re-running the whole pipeline from scratch. Absent for an ordinary
   * fresh run. The original tree is only ever **read** here, never written — this run is a *successor*
   * with its own root run id and its own `.path/runs/` tree (resume-restore-semantics.md §4).
   */
  resume?: ResumeInput;
  /**
   * Where the root `workflow.json` lives, as a path **relative to the store dir** (#202, ADR 0006) —
   * recorded on the root run's `workflow_path` as provenance for a central `-C` store (ADR 0005).
   * The launcher owns it because only the launcher knows both the file path and where the store was
   * relocated to; the engine reads no fs of its own. Absent for a server-hosted run — the root run's
   * `workflow_id`/`workflow_name` (read from the file itself) still identify it.
   */
  sourceWorkflowPath?: string;
}

/**
 * What a successor run needs from the original tree to resume it (#172). The engine core does no I/O
 * of its own, so both halves are supplied by the caller: the run rows to plan reuse from, and a
 * reader that loads a blob (a reused run's `output.json`, a re-entered workflow-run's `context.json`)
 * out of the read-only original tree. Every read happens once, at the point of reuse
 * (resume-restore-semantics.md) — nothing is copied into the new tree ahead of time.
 */
export interface ResumeInput {
  /** Every run row of the original tree — `planReuse`'s input (#170), the whole tree not just the root. */
  originalRuns: RunRecord[];
  /** Loads one blob of an original run by filename (`RUN_BLOB_FILE.output` / `.context`). */
  readBlob: (run: RunRecord, filename: string) => JsonValue;
}

// Shaped differently from @path/schema's success/failure results: a failed run still carries
// the last-succeeded node's output (useful to a caller even on failure), so `output` is
// unconditional rather than living only in a success branch.
export interface RunResult {
  // `cancelled` is a run whose leaf steps the engine killed best-effort (mvp spec §5.6): because a
  // sibling parallel branch failed (#24), or because an operator aborted `RunOptions.signal` (#52) —
  // which any run in the tree, the root included, may end on.
  status: "succeeded" | "failed" | "cancelled";
  /**
   * On success: the workflow's `output` map, evaluated at successful run end (format doc §6.4) —
   * absent map = `{}`, and the value is **real**, secrets included; it is the run's product.
   * Otherwise: the run's input, carried back for debugging, and **masked** — a failed or cancelled
   * run has no output *contract*, so nothing is owed a real value. See `runWorkflow`'s return.
   */
  output: JsonValue;
  /** Present on failure, and always **masked** — see `runWorkflow`'s return. */
  error?: string;
}

function describeInterpolationError(nodeName: string, err: unknown): string {
  if (err instanceof InterpolationError) return `node "${nodeName}": ${err.message}`;
  throw err; // an unexpected error is a bug, not a data-flow failure — surface it, don't swallow it
}

// ConfigObject and JsonValue are structurally compatible (config's `$secret` wrapper is just a
// plain object shape) but not nominally assignable across their recursive unions.
function configScope(config: ConfigObject): JsonValue {
  return config as unknown as JsonValue;
}

// Everything a workflow-run needs to execute one file: the file, where it lives (for cwd defaults
// and resolving child `ref`s), the input seeding its fresh context, the effective config flowing
// in across any file boundary (operator config at the root; the parent step's effective config for
// a nested run — format doc §8: config crosses, context does not), plus the shared run tree.
interface WorkflowRunParams {
  file: WorkflowFile;
  fileDir: string;
  input: { [key: string]: JsonValue };
  incomingConfig: ConfigObject;
  identity: RunIdentity;
  files?: Map<string, WorkflowFile>;
  /**
   * This run's observation producer (run-emitter.ts), already carrying this run's envelope: built
   * from the tree's masking sink by `runWorkflow` for the root, and by `emitter.child` for a nested
   * workflow-run. The run tree's only door to the audit seam — the raw `emit` never travels here.
   */
  emitter: Emitter;
  /** The environment snapshot every `$env` in this run tree resolves against — taken once (#116). */
  env: EnvSource;
  /**
   * A run-start config failure the root run is to end on before its first node — currently unset
   * `$env` variables (#116). The run is still started and recorded; see `runBody`.
   */
  runStartFailure?: string;
  // Shared by the entire run tree, so the registry and processor cap span nested runs too (mvp spec §5.5).
  runtime: StepRuntime;
  // A nested workflow-run inside a `parallel` branch inherits the block's cancellation, so its own
  // leaf steps are killed too when a sibling branch fails (mvp spec §5.6). The root run carries the
  // operator's own `RunOptions.signal` when there is one (#52) — with no `cancellation`, since a run
  // it kills has no cause run inside the tree.
  signal?: AbortSignal;
  cancellation?: Cancellation;
  // Resume this workflow-run against the original tree (#172): the whole-tree read inputs plus this
  // run's own original counterpart (the run it corresponds to, if any). Absent for a fresh run.
  resume?: { input: ResumeInput; counterpart: RunRecord | undefined };
  // The predecessor's root run id, stamped on this run's `run-started` (#173). Set only on the root
  // run of a resumed tree — a nested run's predecessor is the tree's, not its own, so it never
  // carries one. It is the successor-identity fact persistence records on the root row.
  resumedFromRootRunId?: string;
  // The root workflow's store-relative path (#202), threaded only into the root run's params — a
  // nested workflow-run is started by `runWorkflowNode`, which never sets it, so it stays root-only.
  sourceWorkflowPath?: string;
}

type WorkflowNode = WorkflowFile["body"][number];
type ControlNode = Extract<WorkflowNode, { type: "parallel" | "branch" | "while-do" | "sequence" | "checkpoint" }>;

// The five engine-evaluated control constructs — everything the node walker owns itself, with no run
// of its own (CONTEXT invariant 1). `workflow` is *not* here: it runs a nested workflow-run, so it
// takes the step path beside the leaf types. A `type` that is none of these five is a leaf step —
// `binary`, `prompt`, or any plugin folder — dispatched through the registry (ADR 0019 sub-10). The
// closed set is the six reserved names minus `workflow`, so a plugin type can never fall in here.
function isControlNode(node: WorkflowNode): node is ControlNode {
  return (
    node.type === "parallel" ||
    node.type === "branch" ||
    node.type === "while-do" ||
    node.type === "sequence" ||
    node.type === "checkpoint"
  );
}

/**
 * A leaf step node, read structurally rather than by a closed union: the engine no longer knows every
 * leaf type at compile time (a plugin folder contributes its own), so a leaf runner reads the envelope
 * keys it owns and treats the plugin's own `fields` as an open bag keyed off `registry[type].fields`.
 */
interface LeafStepNode {
  type: string;
  id: string;
  name: string;
  worker?: string;
  config?: ConfigObject;
  input?: JsonValue;
  parse?: "text" | "json";
  publish?: { [key: string]: JsonValue };
  [field: string]: unknown;
}

// The interpolated `input` object must be a JSON object so its top-level keys can seed the child's
// context (format doc §6.3). A bare `"${context.x}"` that resolves to a string/number/array can't.
function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Executes one workflow-run: walks the file's body strictly sequentially (mvp spec §5.1),
 * running `binary` steps as child processes and `workflow` steps as nested workflow-runs (#22),
 * resolving `${}` interpolation, `input`/`publish` maps, config inheritance, and `parse: "json"`
 * at each step (spec §2 invariant 4, format §5–6, §8). The control constructs — checkpoint, branch
 * (#21), parallel (#24), and while-do (#23) — are engine-evaluated in the same walk; any other node
 * type fails the run with a clear message rather than being silently skipped.
 *
 * A workflow-run's own `RunObserver.runStarted`/`runFinished` calls are that run's record — for
 * the root run and, recursively, for each nested workflow-step's run, forming the run tree;
 * persistence (#18) and later logging (#19) subscribe via `observer` rather than this function
 * touching fs/db itself.
 */
async function executeWorkflowRun(params: WorkflowRunParams): Promise<RunResult> {
  const { file, fileDir, input, incomingConfig, identity, files, emitter } = params;

  // Resume (#172): a re-entered workflow-run restores its context blackboard from its original
  // counterpart's recorded `context.json` verbatim (restore-by-load, resume-restore-semantics.md
  // §1–2) instead of seeding fresh from input. A run with no counterpart — added since, or a
  // while-do body's nested run whose iteration can't be told apart — is a first attempt and seeds
  // fresh (invariant 4). The reuse plan is this run's own, scoped to its counterpart's children.
  const resumeCounterpart = params.resume?.counterpart;
  const restoredContext =
    params.resume && resumeCounterpart
      ? (params.resume.input.readBlob(resumeCounterpart, RUN_BLOB_FILE.context) as { [key: string]: JsonValue })
      : undefined;
  const context: { [key: string]: JsonValue } = restoredContext ? { ...restoredContext } : { ...input }; // format doc §6.3
  const resume: RunResume | undefined = params.resume
    ? {
        input: params.resume.input,
        counterpart: resumeCounterpart,
        plan: resumeCounterpart ? planReuse(params.resume.input.originalRuns, file, resumeCounterpart.runId) : new Map(),
      }
    : undefined;
  let previousOutput: JsonValue = input;

  // At the file boundary the incoming (operator or parent-effective) config shadows this file's
  // declared defaults key by key, nearest wins (format doc §8). One of
  // the two points a run materializes effective config, so one of the two that resolve `$env`
  // (#116) — what survives the merge is what a worker can read, and it reaches one holding a real
  // value rather than a wrapper. Idempotent, so the already-resolved incoming half is untouched.
  const fileConfig = resolveConfigEnv(mergeConfig(file.config ?? {}, incomingConfig), params.env).config;
  const run: RunContext = { file, fileDir, fileConfig, identity, emitter, files, env: params.env, runtime: params.runtime, resume, detached: [] };
  const fail = async (error: string): Promise<RunResult> => {
    await emitter.runFinished({ status: "failed", error });
    return { status: "failed", output: previousOutput, error };
  };
  const succeed = async (output: JsonValue): Promise<RunResult> => {
    await emitter.runFinished({ status: "succeeded", output });
    return { status: "succeeded", output };
  };
  // A workflow-run whose leaf step the engine killed — by a failing sibling parallel branch (#24) or
  // by an operator's abort (#52) — ends cancelled (mvp spec §5.6): its own terminal event, distinct
  // from failed; no output contract. For the root run this is the `step-finished` of the implicit
  // root step, so its row lands `cancelled` and the log backends close on it like any other end.
  const cancel = async (): Promise<RunResult> => {
    await emitter.runFinished({ status: "cancelled" });
    return { status: "cancelled", output: previousOutput };
  };

  // A log backend write failure fails the run audit-first (mvp spec §8.2): the logging observer
  // throws ObserverError, which we convert to a failed run here with a best-effort terminal event.
  // Any other thrown error is a bug and propagates — it is not swallowed into a failed run.
  // Each workflow-run converts its own hooks' ObserverError, so a nested run reports failed to
  // its parent and the failure travels up the run tree as an ordinary failed step.
  const failFromObserverError = async (err: ObserverError): Promise<RunResult> => {
    // Honour the exit barrier even on an audit fault: no detached `do-not-wait` branch may outlive
    // its owning run (do-not-wait-join.md §1.1). Best-effort — the audit is already compromised.
    try {
      await settleDetached(run);
    } catch {
      // a detached branch's own audit write may fault too; nothing more to salvage
    }
    try {
      await emitter.runFinished({ status: "failed", error: err.message });
    } catch {
      // audit is already compromised; the best we can do is still report the run as failed
    }
    return { status: "failed", output: previousOutput, error: err.message };
  };

  try {
    return await runBody();
  } catch (err) {
    if (err instanceof ObserverError) return failFromObserverError(err);
    throw err;
  }

  async function runBody(): Promise<RunResult> {
    // Source-workflow identity is root-only (#202, ADR 0006): the root run *is* the top-level
    // workflow (identity.parentRunId === null — invariant 2), so its file's GUID/name identify the
    // producing workflow. A nested workflow-run carries its own file's identity nowhere — its
    // producing node is already named by `nodeId`/`nodeName`. Path rides along only when the launcher
    // supplied one.
    // The emitter gates the root-only trio on `isRoot` itself (run-emitter.ts): the source-workflow
    // id/name/path ride only a root run's `run-started`, and `resumedFromRootRunId` (#173, persisted
    // to the root row) only when supplied. A nested run passes the file id/name and they are dropped.
    await emitter.runStarted({
      input,
      resumedFromRootRunId: params.resumedFromRootRunId,
      workflowId: file.id,
      workflowName: file.name,
      workflowPath: params.sourceWorkflowPath,
    });

    // Resume (#172): the persisted observer just wrote this new run's `context.json` from `input`
    // (its run-started seed). A re-entered workflow-run's real starting context is the restored one,
    // so write it straight through as a fresh, self-sufficient `context.json` under the new tree
    // (resume-restore-semantics.md §1) — overwriting the input-seed with what actually resumes.
    if (restoredContext !== undefined) {
      await emitter.contextChanged(context);
    }

    // A run-start config failure (#116) lands *here* rather than at load: the run exists, is
    // recorded, and ends `failed` before its first node. Two reasons it is a run and not a load
    // error. Operator config is a run input, not a file, so half of what is checked has no load to
    // fail at. And a caller watching a run needs a run to watch — the server answers `POST /v0/runs`
    // only once `run-started` lands (`live-runs.ts`), so a failure with no events would hang the
    // request rather than report itself. Audit-first, the same reading as a failed log backend
    // write: the row is what survives.
    //
    // An operator who aborted before the run started gets `cancelled` regardless, as spec §5.6
    // promises — the sequence walk below is what ends it that way, so this must not pre-empt it.
    if (params.runStartFailure !== undefined && params.signal?.aborted !== true) {
      return fail(params.runStartFailure);
    }

    // The whole body is one node sequence walked against this run's own context; a top-level
    // publish is a context write-through (mvp spec §6). The implicit root step's default input is
    // the workflow input (format doc §6.1).
    const outcome = await runSequence(run, file.body, input, {
      context,
      signal: params.signal,
      cancellation: params.cancellation,
      onPublish: async () => {
        await emitter.contextChanged(context);
      },
    });
    // Enclosing-workflow-run barrier (do-not-wait-join.md §1.1/§2): drain every detached branch to a
    // terminal status before this run reports finished, so the run tree stays strictly nested and
    // `path run` never returns with live work behind it. Runs regardless of the main path's outcome —
    // a `succeeded` run may still have had a `failed` detached branch in its subtree (§5).
    await settleDetached(run);
    if (outcome.status === "failed") return fail(outcome.error);
    if (outcome.status === "cancelled") return cancel();
    previousOutput = outcome.output;

    if (!file.output) {
      return succeed({});
    }
    try {
      const outputScope: InterpolationScope = { config: configScope(fileConfig), context };
      const workflowOutput = interpolateValue(file.output as JsonValue, outputScope);
      return succeed(workflowOutput);
    } catch (err) {
      if (!(err instanceof InterpolationError)) throw err;
      return fail(`workflow output: ${err.message}`);
    }
  }
}

// A `workflow` step: resolve `ref` against the loaded tree and run the child file as a nested
// workflow-run. The child starts from a fresh context seeded only by `stepInput` (context is
// isolated — CONTEXT invariant); the parent's effective config crosses the boundary (§8), and
// `model` rides it now (`@3` §8); the child's `output` map is this step's output object (format §6.4).
async function runWorkflowNode(
  node: Extract<WorkflowFile["body"][number], { type: "workflow" }>,
  stepInput: JsonValue,
  ctx: StepContext,
): Promise<SeqOutcome> {
  if (!isJsonObject(stepInput)) {
    return {
      status: "failed",
      error: `workflow step "${node.name}": input must be a JSON object to seed the child's context (format doc §6.3)`,
    };
  }
  if (!ctx.run.files) {
    return { status: "failed", error: `workflow step "${node.name}": no loaded file tree to resolve ref "${node.ref}"` };
  }
  const childPath = resolve(ctx.run.fileDir, node.ref);
  const childFile = ctx.run.files.get(childPath);
  if (!childFile) {
    return { status: "failed", error: `workflow step "${node.name}": referenced file "${node.ref}" is not in the loaded tree` };
  }

  const childIdentity: RunIdentity = {
    runId: randomUUID(),
    rootRunId: ctx.run.identity.rootRunId,
    parentRunId: ctx.run.identity.runId,
    nodeId: node.id,
    nodeName: node.name,
  };
  const childResult = await executeWorkflowRun({
    file: childFile,
    fileDir: dirname(childPath),
    input: stepInput,
    incomingConfig: ctx.stepConfig, // parent's effective config crosses the file boundary (§8)
    identity: childIdentity,
    files: ctx.run.files,
    // The child run's own emitter over the tree's one masking sink — the raw emit never crosses.
    emitter: ctx.run.emitter.child(childIdentity),
    // The root run's snapshot, so every file in the tree resolves `$env` against one environment
    // (#116). No `runStartFailure`: unset variables are the root run's own check, over the whole tree.
    env: ctx.run.env,
    runtime: ctx.run.runtime,
    signal: ctx.exec.signal,
    cancellation: ctx.exec.cancellation,
    // Resume recurses into every non-succeeded workflow-run, not just the root (#172,
    // resume-restore-semantics.md §2): the child re-enters against its own original counterpart, so
    // its already-succeeded grandchildren reuse rather than re-running from scratch.
    resume: ctx.run.resume
      ? {
          input: ctx.run.resume.input,
          counterpart: findNestedCounterpart(
            ctx.run.resume.input.originalRuns,
            ctx.run.resume.counterpart?.runId,
            node.id,
          ),
        }
      : undefined,
  });

  if (childResult.status === "cancelled") return { status: "cancelled" };
  if (childResult.status === "failed") {
    return { status: "failed", error: `workflow step "${node.name}": ${childResult.error}` };
  }
  return { status: "succeeded", output: childResult.output };
}

// Everything a leaf step run needs from its enclosing workflow-run: the effective config it
// inherits, its place in the run tree, the context it interpolates against, the `signal`
// that kills it in flight — an enclosing `parallel` block's (#24) or the operator's (#52) — and the
// `cancellation` that says which of the two it was.
/**
 * What one step needs: the run it belongs to, the sequence it sits in, and its own effective config.
 * Nothing else — every other field the three step runners used to take is reachable through `run`
 * or `exec`, which is why there is one of these instead of three overlapping literals (#76).
 */
interface StepContext {
  run: RunContext;
  exec: NodeExecContext;
  /** This step's config: the file's effective config with the step's own shadowing it (format §8). */
  stepConfig: ConfigObject;
  /**
   * A leaf runner reports its minted step emitter here, so `runNode` — which applies the publish and
   * therefore holds the post-step context — can snapshot that context under this step's own run id
   * (the per-step `context.json`). Set by `runNode`; a prompt step mints its emitter only after it
   * holds a processor slot, so the callback fires at that point, not before.
   */
  onLeafStep?: (step: StepEmitter) => void;
}

/** What `settleStepResult` needs to turn one worker's `StepResult` into a leaf step's terminal outcome. */
export interface SettleStepResult {
  /** This step run's emitter — the door every terminal observation of the step passes through. */
  step: StepEmitter;
  /** The node, for the name the engine prefixes onto a worker error and the `parse` it applies to a string. */
  node: { name: string; parse?: "text" | "json" };
  /** What the worker returned (ADR 0021 sub-8) — the only two outcomes a worker reports. */
  result: StepResult;
  /** The worker's `meters` flag: a `step-usage` observation is emitted only for a metering worker. */
  meters: boolean;
  /** The step's kill signal — a `parallel` block's or the operator's; `aborted` is what makes it `cancelled`. */
  signal?: AbortSignal;
  /** The enclosing block's cancellation, read for the cause the `run-cancelled` narrates. */
  cancellation?: Cancellation;
}

/**
 * The whole engine-owned mapping from a worker's `StepResult` to a leaf step's `SeqOutcome`, and the
 * one place it lives (#349's class of bug). A worker reports only `succeeded`/`failed` and self-judges
 * which — the SDK-specific "is this success frame really an error" verdict is correctly the worker's,
 * not the engine's (ADR 0020 sub-5). Everything the *engine* does with whatever the worker returned is
 * here, in order, so the sequence and its edge cases are one testable unit rather than spread across the
 * dispatch that calls the worker:
 *
 * 1. **stderr rides every outcome.** Captured diagnostic text (ADR 0020 sub-7) lands in the audit blob
 *    regardless of how the step ended — a cancelled or failed step's diagnostics are still recorded.
 * 2. **`cancelled` outranks the worker's own verdict.** The engine derives it from `signal.aborted`, not
 *    the worker's status (ADR 0021 sub-7): a failing sibling branch or an operator's cancel killed the
 *    worker in flight, and this relabels whatever it returned as `cancelled` so no publish from it lands.
 *    The `run-cancelled` narration carries the cause — `sibling-failed` (its run named by `causeRunId`),
 *    `sibling-succeeded` (a `wait-one` winner, no cause run — wait-one-join.md §5), or `operator` (a root
 *    cancel, also no cause run) — then the `cancelled` `step-finished`, the pair in order.
 * 3. **usage is leaf-only, from a metering worker, and precedes the finish** (§5.7): a step that died
 *    mid-conversation still spent tokens, so it is emitted before a `failed` finish too — but not for a
 *    `cancelled` step, which returns above.
 * 4. **A `failed` worker's error is prefixed with the node name** (ADR 0021 sub-6): the worker names no
 *    step, so every leaf type's failure reads `step "<name>": <worker error>`, and the step's own run is
 *    the cause a cancelling sibling points at (`causeRunId`).
 * 5. **A `succeeded` worker's output gets `parse: "json"`** (format doc §6.5), applied to a *string* only
 *    (ADR 0021): a worker whose output is already a JSON value hands it straight through. A parse failure
 *    fails the step with its own run as the cause. Keeps the parse/finish shape identical across every
 *    leaf type so they can't drift.
 */
export async function settleStepResult(args: SettleStepResult): Promise<SeqOutcome> {
  const { step, node, result, meters, signal, cancellation } = args;

  // 1. stderr rides every outcome, into the audit blob.
  if (result.stderr !== undefined) await step.stderr(result.stderr);

  // 2. The engine owns `cancelled`, derived from the signal rather than the worker's reported status.
  if (signal?.aborted) {
    await step.cancelled({ cause: cancellation?.cause ?? "operator", causeRunId: cancellation?.causeRunId ?? null });
    return { status: "cancelled" };
  }

  // 3. Leaf-only spend (§5.7), from a metering worker only: recorded here, never rolled up — subtree
  //    figures are a read-time SUM. Emitted for a failed step too, before its finish.
  if (meters && (result.usage !== undefined || result.estimatedCostUsd !== undefined)) {
    await step.usage({ usage: result.usage ?? null, estimatedCostUsd: result.estimatedCostUsd ?? null });
  }

  // 4. A worker failure: prefix the node name and end the step, its own run the cancelling cause.
  if (result.status === "failed") {
    const error = `step "${node.name}": ${result.error}`;
    await step.finished({ status: "failed", error });
    return { status: "failed", error, causeRunId: step.runId };
  }

  // 5. Success: `parse: "json"` on a string result, then finish.
  let output: JsonValue = result.output;
  if (node.parse === "json" && typeof result.output === "string") {
    try {
      output = parseStepOutput(result.output);
    } catch (err) {
      if (!(err instanceof OutputParseError)) throw err;
      const parseError = `step "${node.name}": ${err.message}`;
      await step.finished({ status: "failed", error: parseError });
      return { status: "failed", error: parseError, causeRunId: step.runId };
    }
  }
  await step.finished({ status: "succeeded", output });
  return { status: "succeeded", output };
}

// A never-aborting signal for a leaf run outside any `parallel` block and with no operator abort:
// `StepRequest.signal` is required (a worker always has one to chain onto), but a top-level step in a
// non-cancellable run has no enclosing signal. One shared instance — it never fires.
const NEVER_ABORT = new AbortController().signal;

// Unwrap every `$secret` in an effective config object to its real value, for the worker (ADR 0022
// sub-4: config reaches `run` already `$env`/`$secret`-resolved). `$env` is resolved upstream at the
// effective-config merge; this is the `$secret` half. Per config *value*, keyed by the config key, so
// a config field awkwardly named `$secret` is not mistaken for a wrapper (the `resolve-env.ts` rule).
function unwrapConfigSecrets(config: ConfigObject): ConfigObject {
  const resolved: ConfigObject = {};
  for (const [key, value] of Object.entries(config)) {
    resolved[key] = mapSecrets(value as unknown as JsonValue, (secret) => secret) as unknown as ConfigValue;
  }
  return resolved;
}

/**
 * A leaf step of any type: dispatch through the frozen registry to the selected worker and map its
 * `StepResult` (ADR 0021 sub-8). Leaf dispatch is one `(type, worker-name)` lookup with no built-in
 * branch — `binary`/`prompt` are two plugin folders like any other. The engine builds the
 * `StepRequest` (interpolated `fields`, `$env`/`$secret`-resolved `config`, `input`, `cwd`, `signal`),
 * awaits the worker's `run`, and owns the terminal shaping: `cancelled` is derived from
 * `signal.aborted` (a worker never reports it — ADR 0021 sub-7), `usage`/`estimatedCostUsd` ride from
 * a metering worker, `stderr` is captured for the audit blob regardless, and `parse: "json"` applies
 * to a string result only.
 *
 * The processor-concurrency slot is the engine's: a worker whose descriptor sets `needsProcessorSlot`
 * runs under one acquired slot, held for the call (mvp spec §5.5, ADR 0021 sub-5). Its step row starts
 * only once the slot is really held, so a step that cannot get one simply waits; an uncapped worker
 * (`binary`'s `spawn`) never queues. A thrown exception is *not* caught into a failed step: a worker
 * that means "this step failed" returns `failed`, and a throw propagates as an engine fault (ADR 0020
 * sub-5), masked on the way out of `runWorkflow`.
 */
async function runLeafStep(node: LeafStepNode, stepInput: JsonValue, ctx: StepContext): Promise<SeqOutcome> {
  const plugin = ctx.run.runtime.registry[node.type];
  if (!plugin) {
    // Unreachable through a schema-validated file — the load rejects a type no registry contributes.
    // A hand-constructed node can still reach here, so it fails the run loudly rather than silently.
    return { status: "failed", error: `step "${node.name}": unknown step type "${node.type}" — no plugin contributes it` };
  }
  const workerName = node.worker ?? plugin.defaultWorker;
  const descriptor = plugin.workers[workerName];
  if (!descriptor) {
    return { status: "failed", error: `step "${node.name}": step type "${node.type}" has no worker "${workerName}"` };
  }

  // The plugin's own `fields` are the node keys its `fields` fragment names; the engine interpolates
  // each against config+context before the worker reads them (ADR 0022 acceptance #4). Every other key
  // on the node is an envelope field the engine owns, not the worker's.
  const scope: InterpolationScope = { config: configScope(ctx.stepConfig), context: ctx.exec.context };
  let fields: JsonValue;
  try {
    const raw: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(plugin.fields)) {
      const value = (node as { [k: string]: unknown })[key];
      if (value !== undefined) raw[key] = value as JsonValue;
    }
    fields = interpolateValue(raw, scope);
  } catch (err) {
    return { status: "failed", error: describeInterpolationError(node.name, err) };
  }

  // The worker reads real values: `$env` resolved at the effective-config merge, `$secret` unwrapped
  // here (ADR 0022 sub-4). Masking stays a persistence-boundary concern only (ADR 0020).
  const config = unwrapConfigSecrets(ctx.stepConfig);

  const release = descriptor.needsProcessorSlot ? await ctx.run.runtime.semaphore.acquire() : undefined;
  try {
    // The step's run id is minted (and its row starts) only once any processor slot is really held.
    const step = ctx.run.emitter.step(node);
    ctx.onLeafStep?.(step);
    await step.started({ stepType: node.type, workerName, input: stepInput });

    const request: StepRequest = {
      fields: fields as StepRequest["fields"],
      input: stepInput,
      config: config as unknown as StepRequest["config"],
      cwd: ctx.run.fileDir,
      signal: ctx.exec.signal ?? NEVER_ABORT,
    };
    const result = await descriptor.run(request);

    // Everything the engine does with whatever the worker returned lives behind one seam
    // (`settleStepResult`): stderr capture, the signal-derived `cancelled` relabel, leaf-only usage,
    // the node-prefixed failure, and `parse: "json"` on success — in that order, testable on its own.
    return settleStepResult({
      step,
      node,
      result,
      meters: descriptor.meters,
      signal: ctx.exec.signal,
      cancellation: ctx.exec.cancellation,
    });
  } finally {
    // The processor is gone by now; holding its slot any longer would shrink the cap.
    release?.();
  }
}

/**
 * Runs the top-level workflow as the root of a run tree (mvp spec §2, invariant 2): the workflow
 * is wrapped in an implicit root step whose run this call *is*. `workflow` steps in the body spawn
 * nested workflow-runs under it (#22). See `executeWorkflowRun` for the per-run walk.
 */
export async function runWorkflow(
  file: WorkflowFile,
  fileDir: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const runId = randomUUID();
  const configs = collectRunConfigs(file, options);

  // One snapshot for the whole run (#116). The environment is read here and nowhere else, so a
  // variable changed mid-run cannot make a step's config disagree with what the masker collected
  // from the same wrapper at run start.
  const env: EnvSource = { ...process.env };

  // Resolve every `$env` **before** collecting, not stylistically: masking is by value (mvp spec
  // §8.3), so `{"$secret": {"$env": "TOKEN"}}` must already carry the real value here or the masker
  // collects the literal string `TOKEN` and the credential itself reaches disk unmasked. Unset
  // variables fail the run before its first node, naming every one of them (#116, see
  // `runStartFailure` below).
  const { configs: resolvedConfigs, unset } = resolveRunEnv(configs, env);

  // Collect every `$secret` value in effective config once at run start (mvp spec §8.3, #20), then
  // scrub at the one point every observation passes through (#62) — the interpolated values handed
  // to workers stay real, only what crosses into persistence is masked. Masking here rather than in
  // a wrapper is what makes the guarantee unconditional: there is no hook to leave unimplemented and
  // no wrapper for a future caller to skip.
  const masker = collectSecrets(resolvedConfigs);
  for (const warning of masker.warnings) options.warn?.(warning);
  const { observer } = options;

  // The original tree's own root run (`parentRunId === null`), found once: it is both the root run's
  // resume counterpart (#172) and — being the predecessor of this fresh root run — the successor
  // identity fact stamped on its `run-started` (#173).
  const originalRoot = options.resume?.originalRuns.find((r) => r.parentRunId === null);
  const emit: Emit = observer
    ? async (o) => {
        await observer.observe(masker.isEmpty ? o : maskObservation(masker, o));
      }
    : async () => {};

  // The frozen executor registry for this run: the load's own scanned registry (ADR 0019 sub-15),
  // or — for a caller with no load — a folder scan here, with `workerOverrides` merged over whichever
  // one replace-only (ADR 0021 sub-15). Leaf dispatch reads it — `registry[type].workers`.
  const registry = await resolveExecutorRegistry(options.registry, options.workerOverrides, options.stepPluginsDir);

  // The run-start gate (#116, ADR 0022 sub-3), before the first node: unset `$env` variables fail
  // first (config cannot be validated against values it could not resolve); otherwise the effective,
  // resolved config of every leaf step is validated against its type's `config` fragment, one failure
  // naming every missing or mismatched key. `prompt`'s required `model` is enforced here now.
  const runStartFailure =
    unset.length > 0
      ? describeUnsetEnv(unset)
      : validateRunStartConfig(file, fileDir, options.files, options.operatorConfig ?? {}, env, registry);

  // The tree's one masking sink becomes the root run's emitter here; every descendant run gets its
  // own via `emitter.child`, so `emit` itself never travels past this call.
  const rootIdentity: RunIdentity = { runId, rootRunId: runId, parentRunId: null, nodeId: null, nodeName: null };
  let result: RunResult;
  try {
    result = await executeWorkflowRun({
      file,
      fileDir,
      input: options.input ?? {},
      incomingConfig: options.operatorConfig ?? {},
      identity: rootIdentity,
      files: options.files,
      emitter: createEmitter(rootIdentity, emit),
      env,
      runStartFailure,
      // External abort (#52): the operator's signal is the root run's own, and threads down to every
      // descendant run and leaf step through `WorkflowRunParams.signal` exactly as a `parallel` block's
      // does. No `cancellation`: nothing inside the tree failed, so a run it kills has no cause run.
      signal: options.signal,
      // One registry and one semaphore for the whole run tree: the cap is engine-wide, spanning
      // nested workflows and nested parallels alike (mvp spec §5.5).
      runtime: {
        registry,
        semaphore: createProcessorSemaphore(options.processorConcurrency ?? DEFAULT_PROCESSOR_CONCURRENCY),
      },
      // Resume (#172): the root run's original counterpart is the original tree's own root run.
      // From there `executeWorkflowRun` plans reuse and restores context, recursing into every
      // non-succeeded nested workflow-run.
      resume: options.resume ? { input: options.resume, counterpart: originalRoot } : undefined,
      // The successor-identity fact (#173): this fresh root run resumes the original tree, so its own
      // predecessor is that tree's root run id. Stamped on the root `run-started` alone — nested runs
      // never carry one.
      resumedFromRootRunId: originalRoot?.runId,
      // Source-workflow provenance (#202): the root file's store-relative path, recorded on the root
      // row alone. Only `runWorkflow` (the root entry) forwards it; nested runs never carry one.
      sourceWorkflowPath: options.sourceWorkflowPath,
    });
  } catch (err) {
    // A worker threw rather than returning `failed` (ADR 0020 sub-5): the engine does not catch it
    // into a failed step — a crash must not land publishes — but its message may carry a config
    // secret, so the run's masker scrubs the message on the way out. Class and stack are preserved:
    // the same error object is re-thrown, only its message replaced. One placement covers the CLI's
    // stderr and the server's response body at once (sub-6).
    if (!masker.isEmpty && err instanceof Error) {
      err.message = masker.maskString(err.message);
    }
    throw err;
  }

  // What the caller gets back is masked too (#123) — everything except a *succeeded* run's `output`.
  // The line is the output contract, not the field:
  //
  // - **`error`, always.** It is the field carrying text the engine did not compose from workflow
  //   authorship — a failed step's error is the tail of its stderr, where a client prints a rejected
  //   credential. `cli.ts` prints it verbatim on its own stderr and `@path/server` on its console,
  //   which under `$env` is routinely a CI build log: retained, searchable, and read by people who
  //   never held the credential. That is an audit surface, so the persistence boundary is not the
  //   whole of it.
  // - **`output`, unless the run succeeded.** A succeeded run's output is the *product* — the CLI
  //   prints it, and masking it would hand an operator `[secret:key]` where their pipeline's answer
  //   belongs. A failed or cancelled run has no output contract (see `RunResult.output`): what comes
  //   back is the run's input, kept for debugging, and nothing is owed a real value there.
  //
  // Workers still receive real values (mvp spec §8.3) — this narrows what a *finished* run hands
  // back, not the dataflow. Applied here rather than in the CLI because the masker is the run's, is
  // built here, and is not exported (see index.ts) — a CLI-side mask would need it to cross that
  // line. Nested runs need no masking of their own: a child's error is spliced into its parent's, so
  // the root's `error` is where every one of them surfaces. The run-start `$env` failure rides this
  // path too; it names variables and never values, so there is nothing in it to scrub — masked
  // because it is on the path, not because it needs to be.
  //
  // A thrown *bug* escapes all of this: the engine re-throws rather than swallowing one into a
  // failed run, so its message and stack reach the caller unscrubbed. Documented as a limit in mvp
  // spec §8.3 rather than closed, because catching here would change what a bug is.
  if (masker.isEmpty) return result;
  return {
    ...result,
    ...(result.status === "succeeded" ? {} : { output: masker.maskValue(result.output) }),
    ...(result.error !== undefined ? { error: masker.maskString(result.error) } : {}),
  };
}

/**
 * The frozen executor registry for one run, with `workerOverrides` merged over it **replace-only**
 * (ADR 0021 sub-15).
 *
 * The base registry is the load's own (`provided`, `LoadedWorkflow.registry`) when the caller ran a
 * load — so the run dispatches against exactly the registry the schema validated the file against,
 * with no second scan of the folder. A caller with no load (a test, an embedder) passes none, and the
 * folder is scanned here as the fallback, hitting Node's ESM cache for an unchanged folder. `stepPluginsDir`
 * points that fallback scan elsewhere; it is unread when `provided` is set (see `RunOptions.stepPluginsDir`).
 *
 * Either way each plugin and its `workers` map is shallow-cloned before an override is applied, so a
 * replacement never mutates the load's frozen registry or the cached module object a later scan would
 * read again. An override naming a `(type, name)` pair the base did not produce is a hard error, never
 * an insertion — the registry's name set stays owned by the folder scan (ADR 0019 sub-2).
 */
async function resolveExecutorRegistry(
  provided: LoadedStepPluginRegistry | undefined,
  overrides: WorkerOverrides | undefined,
  stepPluginsDir: string | undefined,
): Promise<LoadedStepPluginRegistry> {
  const base = provided ?? (await scanStepPlugins(stepPluginsDir));
  const registry: LoadedStepPluginRegistry = {};
  for (const [type, plugin] of Object.entries(base)) {
    registry[type] = { ...plugin, workers: { ...plugin.workers } };
  }

  if (!overrides) return registry;
  for (const [type, workers] of Object.entries(overrides)) {
    const plugin = registry[type];
    if (!plugin) {
      throw new Error(
        `workerOverrides: unknown step type "${type}" — an override replaces a scanned (type, worker) pair only, never adds one`,
      );
    }
    for (const [name, descriptor] of Object.entries(workers)) {
      if (!(name in plugin.workers)) {
        throw new Error(
          `workerOverrides: step type "${type}" ships no worker "${name}" to replace — an override is replace-only`,
        );
      }
      plugin.workers[name] = descriptor;
    }
  }
  return registry;
}

/**
 * The run-start config validation (ADR 0022 sub-3): walk the whole ref tree the way the run will,
 * threading effective config across each `workflow` boundary exactly as `runWorkflowNode` does, and
 * validate every leaf step's effective, resolved config against its type's `config` fragment. One
 * aggregated failure names every missing or mismatched key across the whole tree — this is where
 * `prompt`'s required `model` is now caught (ADR 0021 sub-10 → ADR 0022 sub-5), before the first step.
 *
 * Config is validated **after** resolution (sub-decision 4): `$env` at the effective-config merge and
 * `$secret` unwrapped, so a fragment's `z.string()` checks the literal a wrapper resolved to. The
 * fragment is `.passthrough()` — effective config legitimately carries keys a sibling leaf declared.
 */
function validateRunStartConfig(
  rootFile: WorkflowFile,
  rootDir: string,
  files: Map<string, WorkflowFile> | undefined,
  operatorConfig: ConfigObject,
  env: EnvSource,
  registry: LoadedStepPluginRegistry,
): string | undefined {
  const issues: string[] = [];

  function walk(file: WorkflowFile, incomingConfig: ConfigObject, dir: string): void {
    const fileConfig = resolveConfigEnv(mergeConfig(file.config ?? {}, incomingConfig), env).config;
    for (const node of walkNodes(file.body)) {
      const nodeConfig = "config" in node ? node.config : undefined;
      if (node.type === "workflow") {
        // The child file inherits this step's effective config across the boundary (format §8), so it
        // is validated once per (file, incoming-config) it is reached with — the same file under two
        // parents is two validations, each against what actually reaches it.
        const stepConfig = resolveConfigEnv(mergeConfig(fileConfig, nodeConfig), env).config;
        const child = files?.get(resolve(dir, node.ref));
        if (child) walk(child, stepConfig, dirname(resolve(dir, node.ref)));
        continue;
      }
      const plugin = registry[node.type];
      if (!plugin) continue; // the schema already rejects a type no registry contributes
      const stepConfig = unwrapConfigSecrets(resolveConfigEnv(mergeConfig(fileConfig, nodeConfig), env).config);
      const result = z.object(plugin.config).passthrough().safeParse(stepConfig);
      if (!result.success) {
        for (const issue of formatIssues(result.error)) {
          issues.push(`step "${node.name}" (type ${node.type}): ${issue}`);
        }
      }
    }
  }

  walk(rootFile, operatorConfig, rootDir);

  if (issues.length === 0) return undefined;
  return `run failed before its first step: ${
    issues.length === 1 ? "config validation failed" : `${issues.length} config validation errors`
  }: ${issues.join("; ")}`;
}

/**
 * Every config object a run can read, in one sweep: operator overrides first (they win a token key
 * on a duplicated value — nearest config), then each reachable file's declared config and each of
 * its steps' configs, since a value rides inheritance to any of them.
 *
 * Two run-start readings share it: masking collects `$secret` values from all of them (#20), and
 * `$env` resolution checks all of them (#116).
 *
 * **Whole-tree, and deliberately so for `$env`.** A file in the loaded tree declaring `{"$env":
 * "OPENAI_KEY"}` forces the variable to be set *even when a parent's config shadows that key* and
 * the declaration can therefore never be read. Harmless for masking; for failing a run it is a real
 * cost, accepted because the alternative — resolving per file as the run reaches it — is a run that
 * starts and dies at step 14 for a variable already missing at step 1. `test/run-workflow.test.ts`
 * pins it so it stays a decision.
 *
 * The descent is @path/schema's (`walkNodes`), not `file.body`: a step's config can sit inside any
 * nesting of control blocks, and a hand-rolled top-level loop silently skipped every one of them —
 * an unmasked secret, and a wrapper handed to a worker in place of a credential.
 */
function collectRunConfigs(rootFile: WorkflowFile, options: RunOptions): ConfigObject[] {
  const configs: ConfigObject[] = [];
  if (options.operatorConfig) configs.push(options.operatorConfig);

  const files = options.files ? [...options.files.values()] : [rootFile];
  if (!files.includes(rootFile)) files.push(rootFile);
  for (const file of files) {
    if (file.config) configs.push(file.config);
    for (const node of walkNodes(file.body)) {
      if ("config" in node && node.config) configs.push(node.config);
    }
  }
  return configs;
}

// A `checkpoint` node: assert its condition over the run's `context` (the branch's snapshot copy
// inside a `parallel`) + the predecessor's `output` (spec §5.2). True → continue; false or a
// strict evaluation error → the run stops as failed (§5.6). Transparent: forwards its
// predecessor's output unchanged — the same object its `output` root read (§5.4). The engine has
// no run for a checkpoint (invariant 1); the event is attributed to this run + the node's id.
async function runCheckpointNode(
  run: RunContext,
  node: CheckpointNode,
  incomingOutput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { outcome, trace } = evaluateCondition(node.condition, { context: exec.context, output: incomingOutput });
  const passed = outcome === "true";
  await run.emitter.checkpointEvaluated(node, { passed, trace });
  if (!passed) {
    return { status: "failed", error: `checkpoint "${node.name}" failed: ${describeConditionFailure(trace)}` };
  }
  return { status: "succeeded", output: incomingOutput };
}

// A `branch` node: evaluate arms in declaration order, first true `when` wins; else the fallback;
// no match and no `else` fails the run (silent fall-through hides authoring bugs — spec §5.2). A
// condition evaluation error in an arm fails the run outright (§5.6). The taken arm's body runs
// as a nested sequence — transparent to the block's `exec` (same context/cancellation) and seeded
// by the block's predecessor's output (default-input chain, §5.4); its last node's output becomes
// the block's output (§5.4).
async function runBranchNode(
  run: RunContext,
  node: BranchNode,
  incomingOutput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const roots = { context: exec.context, output: incomingOutput };
  const traces: Trace[] = [];
  for (const [index, arm] of node.arms.entries()) {
    const { outcome, trace } = evaluateCondition(arm.when, roots);
    traces.push(trace);
    if (outcome === "error") {
      return { status: "failed", error: `branch "${node.name}" arm ${index}: condition evaluation error: ${describeConditionFailure(trace)}` };
    }
    if (outcome === "true") {
      await run.emitter.branchTaken(node, { arm: index, trace });
      // The arm's occupant is a single node (`@2` §4.3), run as a one-node sequence.
      return runSequence(run, [arm.node], incomingOutput, exec);
    }
  }
  if (node.else) {
    await run.emitter.branchTaken(node, { arm: "else", trace: null });
    return runSequence(run, [node.else], incomingOutput, exec);
  }
  await run.emitter.branchNoMatch(node, { traces });
  return { status: "failed", error: `branch "${node.name}": no arm matched and there is no else (spec §5.2)` };
}

// A `while-do` node: check the condition before every iteration against the run's `context` + the
// output that seeds the next iteration's first node (spec §5.2, §5.4). Zero iterations is a normal,
// transparent exit — the block forwards its predecessor's output unchanged. Each iteration's body
// runs as a nested sequence seeded by the previous iteration's last node's output (the cross-
// iteration default-input chain, §5.4); iteration 1 is seeded by the block predecessor's output.
// The block output is the final executed iteration's last node's output. If the condition is still
// true after `max_iterations` completed iterations the run fails (§5.2/§5.6); a condition
// evaluation error fails the run outright (§5.6).
async function runWhileDoNode(
  run: RunContext,
  node: WhileDoNode,
  incomingOutput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { fileConfig } = run;
  let maxIterations: number;
  if (typeof node.max_iterations === "number") {
    maxIterations = node.max_iterations;
  } else {
    const scope: InterpolationScope = { config: configScope(fileConfig), context: exec.context };
    let resolved: string;
    try {
      resolved = interpolateToString(node.max_iterations, scope);
    } catch (err) {
      return { status: "failed", error: describeInterpolationError(node.name, err) };
    }
    const parsed = Number(resolved);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { status: "failed", error: `while-do "${node.name}": max_iterations resolved to "${resolved}", which is not a positive integer` };
    }
    maxIterations = parsed;
  }

  let iterationOutput = incomingOutput;
  let iterations = 0; // completed iterations
  for (;;) {
    const { outcome, trace } = evaluateCondition(node.condition, { context: exec.context, output: iterationOutput });
    if (outcome === "error") {
      return { status: "failed", error: `while-do "${node.name}": condition evaluation error: ${describeConditionFailure(trace)}` };
    }
    if (outcome === "false") {
      await run.emitter.loopExited(node, { reason: "condition-false", iterations, trace });
      return { status: "succeeded", output: iterationOutput };
    }
    // Condition true, but the cap has already been reached: the run fails (post-loop nodes may
    // assume the condition resolved false, so an exhausted loop is an authoring error, not an exit).
    if (iterations >= maxIterations) {
      await run.emitter.loopExited(node, { reason: "max-iterations-exceeded", iterations, trace });
      return { status: "failed", error: `while-do "${node.name}": condition still true after max_iterations (${maxIterations}) — the run fails (spec §5.2)` };
    }
    iterations += 1;
    await run.emitter.iterationStarted(node, { iteration: iterations, trace });
    // The loop body is a single node (`@2` §4.3), run as a one-node sequence each iteration.
    const bodyOutcome = await runSequence(run, [node.node], iterationOutput, exec);
    if (bodyOutcome.status !== "succeeded") return bodyOutcome;
    iterationOutput = bodyOutcome.output;
  }
}

/**
 * Runs **one node** of a workflow body, whatever kind it is: resolves its effective config and its
 * input, executes it, and lands its `publish`. `incomingOutput` is what the default-input chain
 * offers it — its predecessor's output (format doc §6.1).
 *
 * This is the engine's node seam, and there is one of it. Seven kinds sit behind it — three step
 * types executed on a worker, four engine-evaluated logicers and checkpoints (CONTEXT invariant 1)
 * — and a caller, or a test, needs to know none of that. Which of the seven a node is, what config
 * it inherits, whether its output publishes: all of that is on this side of the seam.
 *
 * It replaces five exported walkers and three private ones (#76 got as far as pulling the control
 * nodes to module scope, and stopped there). That split followed how far one ticket reached, not
 * the domain: `branch` was reachable by a test and `binary` was not, though a body may hold either
 * in the same position. Now every kind is reachable the same way, and none of them is a name a
 * caller has to learn.
 */
export async function runNode(
  run: RunContext,
  node: WorkflowNode,
  incomingOutput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  if (isControlNode(node)) {
    if (node.type === "parallel") return runParallelNode(run, node, incomingOutput, exec);
    if (node.type === "checkpoint") return runCheckpointNode(run, node, incomingOutput, exec);
    if (node.type === "branch") return runBranchNode(run, node, incomingOutput, exec);
    if (node.type === "while-do") return runWhileDoNode(run, node, incomingOutput, exec);
    // A `sequence` adds no execution rule (`@2` §4.4): it runs its body as a nested node sequence,
    // seeded by its predecessor's output, and its output is its last child's output — exactly what
    // `runSequence` already does. It is transparent to `exec` (same context/cancellation) like the
    // other logicers.
    if (node.type === "sequence") return runSequence(run, node.body, incomingOutput, exec);
    // The compile-time guard: if the control set grows a member this dispatch does not walk, the build
    // fails here rather than someone discovering it by running a workflow. A leaf step type never
    // reaches this branch — `isControlNode` excludes it — so an unknown *leaf* type is caught below,
    // at the registry lookup, not here.
    const unwalked: never = node;
    const unknown = unwalked as { type: string; id: string };
    return {
      status: "failed",
      error: `node type "${unknown.type}" (node "${unknown.id}") is not supported by this engine`,
    };
  }

  // Only steps carry config, an input map and a publish map — the control nodes are transparent to
  // all three, which is why this half of the function has no counterpart above. The second of the
  // two points effective config is materialized, and so the second that resolves `$env` (#116).
  const stepConfig = resolveConfigEnv(mergeConfig(run.fileConfig, node.config), run.env).config;

  // Resume reuse (#172): a node whose recorded run this successor tree reuses does not execute at
  // all — its output is the original run's recorded `output.json`, read once from the read-only
  // original tree, and a `reuse-marker` is its whole trace (no step-started/step-finished, no run
  // row). A reused `workflow` node collapses its whole subtree here: the plan holds only that node,
  // and returning without `runWorkflowNode` means nothing inside it is ever walked — so the marker
  // fires once per reuse decision, never once per descendant. Everything downstream treats the
  // reused output identically to a freshly produced one, so the `publish` block below is shared.
  const reused = run.resume?.plan.get(node.id);
  let outcome: SeqOutcome;
  // A leaf runner reports its minted step emitter here (via `onLeafStep`), so the post-publish
  // context snapshot below is attributed to the step's own run id. A reused node and a nested
  // `workflow` node leave this undefined — the former emits no step run, the latter keeps its own
  // context.json — so neither gets a per-step snapshot here.
  let leafStep: StepEmitter | undefined;
  if (run.resume && reused) {
    const output = run.resume.input.readBlob(reused, RUN_BLOB_FILE.output);
    await run.emitter.reuseMarker(node, { originalRunId: reused.runId });
    outcome = { status: "succeeded", output };
  } else {
    const scope: InterpolationScope = { config: configScope(stepConfig), context: exec.context };
    let stepInput: JsonValue;
    try {
      stepInput = node.input !== undefined ? interpolateValue(node.input, scope) : incomingOutput;
    } catch (err) {
      return { status: "failed", error: describeInterpolationError(node.name, err) };
    }

    // One context for every step kind, derived rather than hand-built. A `workflow` step runs a nested
    // workflow-run; every other (leaf) type dispatches through the registry — one lookup, no built-in
    // branch (ADR 0021 sub-8). These were two literals side by side, sharing seven fields (#76).
    const step: StepContext = { run, exec, stepConfig, onLeafStep: (emitted) => (leafStep = emitted) };
    if (node.type === "workflow") {
      outcome = await runWorkflowNode(node, stepInput, step);
    } else {
      outcome = await runLeafStep(node as unknown as LeafStepNode, stepInput, step);
    }
  }
  if (outcome.status !== "succeeded") return outcome;

  if (node.publish) {
    const publishScope: InterpolationScope = { config: configScope(stepConfig), context: exec.context, output: outcome.output };
    const updates: { [key: string]: JsonValue } = {};
    try {
      for (const [key, expr] of Object.entries(node.publish)) {
        updates[key] = interpolateValue(expr, publishScope);
      }
    } catch (err) {
      return { status: "failed", error: describeInterpolationError(node.name, err) };
    }
    // Every entry resolves before any is written, so the publish lands atomically (§5.3), before the
    // next node starts. A nested workflow-step publishes to *this* run's context only — never the
    // child's (isolated).
    Object.assign(exec.context, updates);
    await exec.onPublish(updates);
  }

  // Every succeeded leaf step records the enclosing context as it stands now — after its own publish
  // landed — under its own directory, so the context is followable step by step. A step with no
  // publish still snapshots the (unchanged) context, so a run leaves one per step, not one per
  // publish. `leafStep` is set only for a leaf step that actually executed (never a reuse row or a
  // nested workflow-run, which keep no per-step context of their own).
  if (leafStep !== undefined) {
    await leafStep.context(exec.context);
  }
  return outcome;
}

/**
 * Walks a node sequence strictly in order (mvp spec §5.1), threading the default-input chain: a
 * node with no `input` reads its predecessor's output (`seedInput` for the first node — the
 * block's predecessor's output, format doc §6.1). Returns the last node's output, or the first
 * non-success outcome (fail-fast).
 *
 * What one node does is `runNode`'s; what a sequence does is this: order, the chain, and where an
 * abort can be noticed. This one function serves the top-level body, each `parallel` branch, each
 * branch arm and each loop iteration — every block is transparent to one uniform chain (§5.4).
 */
export async function runSequence(
  run: RunContext,
  nodes: WorkflowFile["body"],
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  let previous: JsonValue = seedInput;

  for (const node of nodes) {
    // An abort that arrived between two nodes stops the walk here (mvp spec §5.6): starting a step
    // run only to kill it would put a run in the record that never really ran, and the control
    // nodes around it — a checkpoint, a while-do's next iteration — have no process to interrupt,
    // so this is the only place they can notice a cancellation at all.
    if (exec.signal?.aborted) return { status: "cancelled" };

    const outcome = await runNode(run, node, previous, exec);
    if (outcome.status !== "succeeded") return outcome;
    previous = outcome.output;
  }

  return { status: "succeeded", output: previous };
}
