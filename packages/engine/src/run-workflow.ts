import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { walkNodes, type BranchNode, type CheckpointNode, type ConfigObject, type JsonValue, type RunRecord, type WhileDoNode, type Worker, type WorkflowFile } from "@path/schema";
import { runBinaryStep } from "./binary-worker.js";
import { findNestedCounterpart, pickReusedWaitOneWinner, planReuse, type ReusePlan } from "./plan-reuse.js";
import { RUN_BLOB_FILE } from "./persistence/paths.js";
import { describeConditionFailure, evaluateCondition, type Trace } from "./condition.js";
import { InterpolationError, interpolateToString, interpolateValue, type InterpolationScope } from "./interpolate.js";
import { createAgentSdkWorker } from "./llm/agent-sdk-worker.js";
import type { LlmWorker } from "./llm/llm-worker.js";
import {
  createProcessorSemaphore,
  DEFAULT_LLM_CONCURRENCY,
  type ProcessorSemaphore,
} from "./llm/processor-semaphore.js";
import { mergeConfig } from "./merge-config.js";
import { OutputParseError, parseStepOutput } from "./parse-output.js";
import { describeUnsetEnv, type EnvSource, resolveConfigEnv, resolveRunEnv } from "./resolve-env.js";
import { type Observation, ObserverError, type RunObserver } from "./run-observer.js";
import { collectSecrets, maskObservation } from "./secret-mask.js";

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
   * Where `prompt` steps execute (#25). Defaults to the pinned Agent SDK worker (mvp spec §7),
   * which loads the SDK only when a prompt step actually runs; tests and any future alternate
   * worker (headless CLI, remote runner) substitute their own through this seam.
   */
  llmWorker?: LlmWorker;
  /**
   * The engine-wide cap on concurrent LLM processors (mvp spec §5.5) — default 4. One semaphore
   * covers the whole run tree, so nested workflows and nested parallels share it.
   */
  llmConcurrency?: number;
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

/**
 * The engine's single emit choke point, threaded to every node of the run tree in place of the
 * observer itself (#62). Two things are guaranteed here and therefore nowhere else:
 *
 * - **Secrets are masked** (mvp spec §8.3) before anything crosses the seam. No caller has to apply
 *   a wrapper, so no caller can forget to — and no wrapper can cover part of the union.
 * - **The absent observer is handled once.** A run with nothing observing it emits into a no-op, so
 *   the 24 call sites downstream are plain `await emit(...)` rather than optional chains.
 */
export type Emit = (o: Observation) => Promise<void>;

/**
 * The LLM execution resources one run tree shares: the worker `prompt` steps run on, and the
 * single semaphore that caps how many of its processors are live at once (mvp spec §5.5).
 */
export interface LlmRuntime {
  worker: LlmWorker;
  semaphore: ProcessorSemaphore;
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

// The result of running one node (or a whole node sequence). A step run that a failing sibling
// cancelled reports `cancelled`; a genuine failure carries its `error` and, when a killed step run
// is the trigger, the `causeRunId` the sibling cancellations narrate (mvp spec §5.6).
export type SeqOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error: string; causeRunId?: string }
  | { status: "cancelled" };

// The shared cancellation of one `parallel` block: its branches all run under `signal`, and either a
// branch failing (`collect`) or a branch winning the race (`wait-one`) aborts the in-flight siblings
// best-effort. `cause` records which — `sibling-failed` or `sibling-succeeded` (wait-one-join.md §5)
// — and is null until one fires (an outside abort, an operator cancelling the root run, leaves it
// null). For `sibling-failed` the failing step run's id becomes `causeRunId`, which the losers'
// run-cancelled events point back at; a win has no cause run, so `causeRunId` stays null there too.
export interface Cancellation {
  signal: AbortSignal;
  causeRunId: string | null;
  cause: "sibling-failed" | "sibling-succeeded" | null;
  /** A `collect` branch failed: cancel in-flight siblings, `causeRunId` naming the failing run. */
  trigger(causeRunId: string): void;
  /** A `wait-one` branch won the race: cancel the still-running losers (no cause run). */
  triggerWin(): void;
}

// What each node in a sequence reads and writes: the `context` it sees (the run's own for the
// top-level body; a per-branch snapshot copy inside a `parallel` block, so siblings never observe
// each other's writes — mvp spec §5.3), the `signal`/`cancellation` of any enclosing parallel, and
// `onPublish` — how a landed publish is surfaced (context write-through at the top level; buffered
// for the join inside a branch).
export interface NodeExecContext {
  context: { [key: string]: JsonValue };
  signal?: AbortSignal;
  cancellation?: Cancellation;
  onPublish: (updates: { [key: string]: JsonValue }) => Promise<void>;
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

// One workflow-run's identity within the run tree (#22). The root run has `parentRunId: null`
// and `nodeId: null`; a nested workflow-step's run carries its parent run's id and the `workflow`
// node's id — workflow-as-step means the child run *is* that step's run (CONTEXT invariant 2).
export interface RunIdentity {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  /** The `workflow` node's GUID `id` for a nested run; null for the root (ADR 0007). */
  nodeId: string | null;
  /** The `workflow` node's human `name` for a nested run; null for the root (ADR 0007). */
  nodeName: string | null;
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
  emit: Emit;
  /** The environment snapshot every `$env` in this run tree resolves against — taken once (#116). */
  env: EnvSource;
  /**
   * A run-start config failure the root run is to end on before its first node — currently unset
   * `$env` variables (#116). The run is still started and recorded; see `runBody`.
   */
  runStartFailure?: string;
  // Shared by the entire run tree, so the processor cap spans nested runs too (mvp spec §5.5).
  llm: LlmRuntime;
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

/**
 * Everything that is fixed for the life of one workflow-run, threaded to every node walker.
 *
 * The mutable half — the context a sequence writes to, its cancellation, how a publish lands — is
 * `NodeExecContext`, and varies per sequence (a `parallel` branch gets its own snapshot copy). This
 * is the other half: the file being run, its effective config, who this run is, and the shared
 * resources of the run tree.
 *
 * Splitting the two is what lets the walkers live at module scope (#76). They used to be nested in
 * a 392-line closure and were reached only through a full `runWorkflow`, so the branch, loop and
 * join semantics that carry the spec had no seam a test could aim at. Four overlapping context bags
 * became these two.
 */
export interface RunContext {
  file: WorkflowFile;
  /** The workflow file's own directory: binary `cwd` defaults and nested `ref`s resolve against it. */
  fileDir: string;
  /** This file's declared config with the incoming config shadowing it, nearest wins (format §8). */
  fileConfig: ConfigObject;
  identity: RunIdentity;
  emit: Emit;
  /** The run tree's environment snapshot, for the `$env` in a step's own config (#116). */
  env: EnvSource;
  files?: Map<string, WorkflowFile>;
  /** Shared by the whole run tree, so the processor cap spans nested runs too (mvp spec §5.5). */
  llm: LlmRuntime;
  /** This workflow-run's resume state (#172), when the run is being resumed; absent for a fresh run. */
  resume?: RunResume;
  /**
   * Detached `do-not-wait` branch runs launched under this workflow-run (do-not-wait-join.md §2): a
   * `do-not-wait` block starts every branch and does *not* await it at the join, pushing its run here
   * instead. The owning run drains these at its exit barrier (`settleDetached`, §1.1/§2) so the tree
   * stays strictly nested and `path run` never leaves live work behind. Each promise resolves on the
   * branch reaching a terminal status; a branch failure is isolated (§5), so the promise never rejects
   * except on an audit (ObserverError) fault.
   */
  detached: Promise<void>[];
}

/**
 * One workflow-run's resume state (#172): the whole-tree read inputs, this run's own original
 * counterpart, and the reuse plan computed for *this* run's direct children. `runNode` consults
 * `plan` to decide whether a node reuses; `runWorkflowNode` uses `input`/`counterpart` to find a
 * non-reused nested workflow-run's own counterpart before recursing into it.
 */
interface RunResume {
  input: ResumeInput;
  /** The original run this successor workflow-run corresponds to, or undefined for a fresh (added) run. */
  counterpart: RunRecord | undefined;
  /** Node ids of this run's direct children that reuse, each pointing at the original run it reuses. */
  plan: ReusePlan;
}

type WorkflowNode = WorkflowFile["body"][number];
type StepNode = Extract<WorkflowNode, { type: "binary" | "workflow" | "prompt" }>;

// Only steps carry `config`/`input`/`publish` and execute on a worker; the control nodes around
// them are engine-evaluated logicers with no run of their own (CONTEXT invariant 1).
function isStepNode(node: WorkflowNode): node is StepNode {
  return node.type === "binary" || node.type === "workflow" || node.type === "prompt";
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
  const { file, fileDir, input, incomingConfig, identity, files, emit } = params;
  const { runId, rootRunId } = identity;

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
  // declared defaults key by key, nearest wins (format doc §8); worker never crosses (§7). One of
  // the two points a run materializes effective config, so one of the two that resolve `$env`
  // (#116) — what survives the merge is what a worker can read, and it reaches one holding a real
  // value rather than a wrapper. Idempotent, so the already-resolved incoming half is untouched.
  const fileConfig = resolveConfigEnv(mergeConfig(file.config ?? {}, incomingConfig), params.env).config;
  const run: RunContext = { file, fileDir, fileConfig, identity, emit, files, env: params.env, llm: params.llm, resume, detached: [] };
  const fail = async (error: string): Promise<RunResult> => {
    await emit({ type: "run-finished", runId, rootRunId, status: "failed", error });
    return { status: "failed", output: previousOutput, error };
  };
  const succeed = async (output: JsonValue): Promise<RunResult> => {
    await emit({ type: "run-finished", runId, rootRunId, status: "succeeded", output });
    return { status: "succeeded", output };
  };
  // A workflow-run whose leaf step the engine killed — by a failing sibling parallel branch (#24) or
  // by an operator's abort (#52) — ends cancelled (mvp spec §5.6): its own terminal event, distinct
  // from failed; no output contract. For the root run this is the `step-finished` of the implicit
  // root step, so its row lands `cancelled` and the log backends close on it like any other end.
  const cancel = async (): Promise<RunResult> => {
    await emit({ type: "run-finished", runId, rootRunId, status: "cancelled" });
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
      await emit({ type: "run-finished", runId, rootRunId, status: "failed", error: err.message });
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
    const isRoot = identity.parentRunId === null;
    await emit({ type: "run-started",
      runId,
      rootRunId,
      parentRunId: identity.parentRunId,
      nodeId: identity.nodeId,
      nodeName: identity.nodeName,
      input,
      worker: file.worker,
      // Set only on a resumed tree's root run (#173) — persistence writes it to the root row's
      // `resumed_from_root_run_id`. Undefined everywhere else, including nested resumed runs.
      ...(params.resumedFromRootRunId !== undefined ? { resumedFromRootRunId: params.resumedFromRootRunId } : {}),
      ...(isRoot ? { workflowId: file.id, workflowName: file.name } : {}),
      ...(isRoot && params.sourceWorkflowPath !== undefined ? { workflowPath: params.sourceWorkflowPath } : {}),
    });

    // Resume (#172): the persisted observer just wrote this new run's `context.json` from `input`
    // (its run-started seed). A re-entered workflow-run's real starting context is the restored one,
    // so write it straight through as a fresh, self-sufficient `context.json` under the new tree
    // (resume-restore-semantics.md §1) — overwriting the input-seed with what actually resumes.
    if (restoredContext !== undefined) {
      await emit({ type: "context-changed", runId, rootRunId, context });
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
        await emit({ type: "context-changed", runId, rootRunId, context });
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
// isolated — CONTEXT invariant); the parent's effective config crosses the boundary but its
// worker default does not; the child's `output` map is this step's output object (format §6.4).
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

  const childResult = await executeWorkflowRun({
    file: childFile,
    fileDir: dirname(childPath),
    input: stepInput,
    incomingConfig: ctx.stepConfig, // parent's effective config crosses the file boundary (§8)
    identity: {
      runId: randomUUID(),
      rootRunId: ctx.run.identity.rootRunId,
      parentRunId: ctx.run.identity.runId,
      nodeId: node.id,
      nodeName: node.name,
    },
    files: ctx.run.files,
    emit: ctx.run.emit,
    // The root run's snapshot, so every file in the tree resolves `$env` against one environment
    // (#116). No `runStartFailure`: unset variables are the root run's own check, over the whole tree.
    env: ctx.run.env,
    llm: ctx.run.llm,
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

// Everything a leaf step run needs from its enclosing workflow-run: the effective config and file
// worker it inherits, its place in the run tree, the context it interpolates against, the `signal`
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
}

// The tail every leaf step shares once its worker has produced a raw string output: apply
// `parse: "json"` (format doc §6.5) and emit the terminal `stepFinished`. A parse failure fails
// the step with its own run as the cause; otherwise the (parsed or raw) output succeeds. Keeps the
// parse/finish shape identical across binary and prompt steps so the two can't drift.
async function finishLeafStep(
  emit: Emit,
  ids: { runId: string; rootRunId: string },
  node: { name: string; parse?: "text" | "json" },
  rawOutput: string,
): Promise<SeqOutcome> {
  let output: JsonValue = rawOutput;
  if (node.parse === "json") {
    try {
      output = parseStepOutput(rawOutput);
    } catch (err) {
      if (!(err instanceof OutputParseError)) throw err;
      const parseError = `step "${node.name}": ${err.message}`;
      await emit({ type: "step-finished", runId: ids.runId, rootRunId: ids.rootRunId, status: "failed", error: parseError });
      return { status: "failed", error: parseError, causeRunId: ids.runId };
    }
  }
  await emit({ type: "step-finished", runId: ids.runId, rootRunId: ids.rootRunId, status: "succeeded", output });
  return { status: "succeeded", output };
}

// The tail every leaf step shares once the engine has killed it instead of letting it finish (mvp
// spec §5.6): narrate the cancellation with its cause, then end the run `cancelled` rather than
// `failed` — so no publish from it lands. The cause is read off the enclosing `parallel` block's
// cancellation at kill time. Three sources of an abort: a `collect` sibling failing
// (`sibling-failed`, its run named by `causeRunId`), a `wait-one` sibling winning the race
// (`sibling-succeeded`, no cause run — wait-one-join.md §5), or the abort coming from outside the run
// tree, i.e. an operator cancelling the root run (#52) — the block has recorded no cause, so `cause`
// is null and this reads as `operator` with no cause run to point at.
async function cancelLeafStep(
  emit: Emit,
  ids: { runId: string; rootRunId: string },
  node: { id: string; name: string },
  cancellation: Cancellation | undefined,
): Promise<SeqOutcome> {
  const causeRunId = cancellation?.causeRunId ?? null;
  const cause = cancellation?.cause ?? "operator";
  await emit({ type: "run-cancelled",
    runId: ids.runId,
    rootRunId: ids.rootRunId,
    nodeId: node.id,
    nodeName: node.name,
    cause,
    causeRunId,
  });
  await emit({ type: "step-finished", runId: ids.runId, rootRunId: ids.rootRunId, status: "cancelled" });
  return { status: "cancelled" };
}

/**
 * A `prompt` step: run it on the LLM worker as one **fresh processor**, torn down when the step
 * completes (mvp spec §5.5) — no session reuse, so the step reads exactly what its `input` map
 * built. The processor slot comes from the engine-wide semaphore first, so a step that cannot get
 * one simply waits (and its run row only starts once it is really running); binary steps are
 * uncapped and never queue behind it.
 *
 * `usage` and `estimated_cost_usd` are reported here, on this leaf run, for both a succeeded and a
 * failed processor — a step that died mid-conversation still spent tokens (§5.7, §7).
 */
async function runPromptNode(
  node: Extract<WorkflowNode, { type: "prompt" }>,
  stepInput: JsonValue,
  ctx: StepContext,
): Promise<SeqOutcome> {
  const { emit } = ctx.run;
  const { rootRunId } = ctx.run.identity;
  const scope: InterpolationScope = { config: configScope(ctx.stepConfig), context: ctx.exec.context };
  const effectiveWorker: Worker = node.worker ?? ctx.run.file.worker;

  // Worker is a *binding*, not a suggestion: a prompt step bound to the local engine has no
  // processor to run on, and silently treating it as an LLM step would hide the authoring bug.
  if (effectiveWorker.type !== "llm") {
    return {
      status: "failed",
      error: `prompt step "${node.name}": needs an llm worker, but its effective worker is "${effectiveWorker.type}" (format doc §7)`,
    };
  }

  let model: string;
  let prompt: string;
  try {
    model = interpolateToString(effectiveWorker.model, scope); // worker values are interpolable (§7)
    prompt = interpolateToString(node.prompt, scope);
  } catch (err) {
    return { status: "failed", error: describeInterpolationError(node.name, err) };
  }

  const release = await ctx.run.llm.semaphore.acquire();
  let result;
  try {
    const stepRunId = randomUUID();
    await emit({ type: "step-started",
      runId: stepRunId,
      rootRunId,
      parentRunId: ctx.run.identity.runId,
      nodeId: node.id,
      nodeName: node.name,
      stepType: node.type,
      worker: effectiveWorker,
      input: stepInput,
    });

    result = await ctx.run.llm.worker.runPrompt({
      nodeName: node.name,
      model,
      prompt,
      input: stepInput,
      // The `options` bag is worker-side: MCP servers and skills pass straight through, and no
      // engine code interprets them (mvp spec §7).
      options: effectiveWorker.options,
      cwd: ctx.run.fileDir,
      signal: ctx.exec.signal,
    });

    if (result.status === "cancelled") {
      // A failing sibling parallel branch or an operator's cancel killed this processor (mvp spec
      // §5.6) — not a failure of this step. Awaited here rather than returned, so the processor slot
      // is only released once the cancellation has been narrated.
      return await cancelLeafStep(emit, { runId: stepRunId, rootRunId }, node, ctx.exec.cancellation);
    }

    // Leaf-only (§5.7): recorded on this run, never rolled up — subtree figures are a read-time SUM.
    if (result.usage !== null || result.estimatedCostUsd !== null) {
      await emit({ type: "step-usage",
        runId: stepRunId,
        rootRunId,
        usage: result.usage,
        estimatedCostUsd: result.estimatedCostUsd,
      });
    }

    if (result.status === "failed") {
      await emit({ type: "step-finished", runId: stepRunId, rootRunId, status: "failed", error: result.error });
      return { status: "failed", error: result.error, causeRunId: stepRunId };
    }

    return finishLeafStep(emit, { runId: stepRunId, rootRunId }, node, result.output);
  } finally {
    // The processor is gone by now either way; holding its slot any longer would shrink the cap.
    release();
  }
}

// A `binary` step: resolve command/args/cwd, spawn the child process, apply `parse: "json"`, and
// emit the leaf step-run's observer lifecycle. stderr is reported (even on success) for the audit
// blob; publish/default-input threading stays with the caller.
async function runBinaryNode(
  node: Extract<WorkflowNode, { type: "binary" }>,
  stepInput: JsonValue,
  // `ctx.exec.signal` kills the child in flight — on a sibling branch's failure (#24) or an operator's
  // cancel of the root run (#52) — and `ctx.exec.cancellation` is what tells those two apart afterwards.
  ctx: StepContext,
): Promise<SeqOutcome> {
  const { emit } = ctx.run;
  const { rootRunId } = ctx.run.identity;
  const scope: InterpolationScope = { config: configScope(ctx.stepConfig), context: ctx.exec.context };
  const effectiveWorker: Worker = node.worker ?? ctx.run.file.worker;

  let command: string;
  let args: string[];
  let cwd: string;
  try {
    command = interpolateToString(node.command, scope);
    args = (node.args ?? []).map((arg) => interpolateToString(arg, scope));
    // A relative `cwd` is resolved against the workflow file's directory, not the process's —
    // the same anchor as the documented default (format doc §4.2). Anchoring it to wherever
    // `path run` happened to be invoked from would make `"cwd": "."` mean something different
    // from omitting `cwd`, and would make a workflow's behaviour depend on the caller's shell.
    cwd = node.cwd !== undefined ? resolve(ctx.run.fileDir, interpolateToString(node.cwd, scope)) : ctx.run.fileDir;
  } catch (err) {
    return { status: "failed", error: describeInterpolationError(node.name, err) };
  }

  const stepRunId = randomUUID();
  await emit({ type: "step-started",
    runId: stepRunId,
    rootRunId,
    parentRunId: ctx.run.identity.runId,
    nodeId: node.id,
    nodeName: node.name,
    stepType: node.type,
    worker: effectiveWorker,
    input: stepInput,
  });

  const result = await runBinaryStep({ name: node.name, command, args, cwd }, stepInput, ctx.exec.signal);
  await emit({ type: "step-stderr", runId: stepRunId, rootRunId, stderr: result.stderr });

  if (result.status === "cancelled") {
    // A failing sibling parallel branch or an operator's cancel killed this child process (mvp spec
    // §5.6) — not a failure of this step.
    return cancelLeafStep(emit, { runId: stepRunId, rootRunId }, node, ctx.exec.cancellation);
  }

  if (result.status === "failed") {
    await emit({ type: "step-finished", runId: stepRunId, rootRunId, status: "failed", error: result.error });
    return { status: "failed", error: result.error, causeRunId: stepRunId };
  }

  return finishLeafStep(emit, { runId: stepRunId, rootRunId }, node, result.output);
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

  const result = await executeWorkflowRun({
    file,
    fileDir,
    input: options.input ?? {},
    incomingConfig: options.operatorConfig ?? {},
    identity: { runId, rootRunId: runId, parentRunId: null, nodeId: null, nodeName: null },
    files: options.files,
    emit,
    env,
    runStartFailure: unset.length > 0 ? describeUnsetEnv(unset) : undefined,
    // External abort (#52): the operator's signal is the root run's own, and threads down to every
    // descendant run and leaf step through `WorkflowRunParams.signal` exactly as a `parallel` block's
    // does. No `cancellation`: nothing inside the tree failed, so a run it kills has no cause run.
    signal: options.signal,
    // One worker and one semaphore for the whole run tree: the cap is engine-wide, spanning
    // nested workflows and nested parallels alike (mvp spec §5.5).
    llm: {
      worker: options.llmWorker ?? createAgentSdkWorker(),
      semaphore: createProcessorSemaphore(options.llmConcurrency ?? DEFAULT_LLM_CONCURRENCY),
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
  const { emit, identity } = run;
  const { runId, rootRunId } = identity;
  const { outcome, trace } = evaluateCondition(node.condition, { context: exec.context, output: incomingOutput });
  const passed = outcome === "true";
  await emit({ type: "checkpoint-evaluated", runId, rootRunId, nodeId: node.id, nodeName: node.name, passed, trace });
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
  const { emit, identity } = run;
  const { runId, rootRunId } = identity;
  const roots = { context: exec.context, output: incomingOutput };
  const traces: Trace[] = [];
  for (const [index, arm] of node.arms.entries()) {
    const { outcome, trace } = evaluateCondition(arm.when, roots);
    traces.push(trace);
    if (outcome === "error") {
      return { status: "failed", error: `branch "${node.name}" arm ${index}: condition evaluation error: ${describeConditionFailure(trace)}` };
    }
    if (outcome === "true") {
      await emit({ type: "branch-taken", runId, rootRunId, nodeId: node.id, nodeName: node.name, arm: index, trace });
      return runSequence(run, arm.body, incomingOutput, exec);
    }
  }
  if (node.else) {
    await emit({ type: "branch-taken", runId, rootRunId, nodeId: node.id, nodeName: node.name, arm: "else", trace: null });
    return runSequence(run, node.else, incomingOutput, exec);
  }
  await emit({ type: "branch-no-match", runId, rootRunId, nodeId: node.id, nodeName: node.name, traces });
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
  const { emit, identity, fileConfig } = run;
  const { runId, rootRunId } = identity;
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
      await emit({ type: "loop-exited", runId, rootRunId, nodeId: node.id, nodeName: node.name, reason: "condition-false", iterations, trace });
      return { status: "succeeded", output: iterationOutput };
    }
    // Condition true, but the cap has already been reached: the run fails (post-loop nodes may
    // assume the condition resolved false, so an exhausted loop is an authoring error, not an exit).
    if (iterations >= maxIterations) {
      await emit({ type: "loop-exited", runId, rootRunId, nodeId: node.id, nodeName: node.name, reason: "max-iterations-exceeded", iterations, trace });
      return { status: "failed", error: `while-do "${node.name}": condition still true after max_iterations (${maxIterations}) — the run fails (spec §5.2)` };
    }
    iterations += 1;
    await emit({ type: "iteration-started", runId, rootRunId, nodeId: node.id, nodeName: node.name, iteration: iterations, trace });
    const bodyOutcome = await runSequence(run, node.body, iterationOutput, exec);
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
  if (!isStepNode(node)) {
    if (node.type === "parallel") return runParallelNode(run, node, incomingOutput, exec);
    if (node.type === "checkpoint") return runCheckpointNode(run, node, incomingOutput, exec);
    if (node.type === "branch") return runBranchNode(run, node, incomingOutput, exec);
    if (node.type === "while-do") return runWhileDoNode(run, node, incomingOutput, exec);
    // Two guards, deliberately. The `never` assertion is the compile-time one: if the format gains
    // a node type this dispatch does not walk, the build fails rather than someone discovering it
    // by running a workflow. The runtime branch below survives anyway, because a hand-constructed
    // `WorkflowFile` can reach the engine without passing the schema — it must fail the run loudly
    // rather than be silently skipped.
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
  if (run.resume && reused) {
    const output = run.resume.input.readBlob(reused, RUN_BLOB_FILE.output);
    await run.emit({
      type: "reuse-marker",
      runId: run.identity.runId,
      rootRunId: run.identity.rootRunId,
      nodeId: node.id,
      nodeName: node.name,
      originalRunId: reused.runId,
    });
    outcome = { status: "succeeded", output };
  } else {
    const scope: InterpolationScope = { config: configScope(stepConfig), context: exec.context };
    let stepInput: JsonValue;
    try {
      stepInput = node.input !== undefined ? interpolateValue(node.input, scope) : incomingOutput;
    } catch (err) {
      return { status: "failed", error: describeInterpolationError(node.name, err) };
    }

    // One context for all three step types, derived rather than hand-built. These were two literals
    // constructed side by side, sharing seven identical fields (#76).
    const step: StepContext = { run, exec, stepConfig };
    if (node.type === "workflow") {
      outcome = await runWorkflowNode(node, stepInput, step);
    } else if (node.type === "prompt") {
      outcome = await runPromptNode(node, stepInput, step);
    } else {
      outcome = await runBinaryNode(node, stepInput, step);
    }
  }
  if (outcome.status !== "succeeded" || !node.publish) return outcome;

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

type ParallelNode = Extract<WorkflowFile["body"][number], { type: "parallel" }>;
type ParallelBranch = ParallelNode["branches"][number];

// One branch's run: which branch, how it ended, and the publishes it buffered (landed only if it is
// the collect join's all-succeeded set, or the wait-one join's winner — wait-one-join.md §4).
interface BranchResult {
  branch: ParallelBranch;
  outcome: SeqOutcome;
  buffer: { [key: string]: JsonValue };
}

// The winning branch of a `wait-one` race, with the output and buffered publishes only it lands (§3, §4).
interface WaitOneWinner {
  branch: ParallelBranch;
  output: JsonValue;
  buffer: { [key: string]: JsonValue };
}

// Land the `wait-one` winner's buffered publishes into context and narrate the win. Only the winner
// lands (wait-one-join.md §4); the block output is the stable `{ winner: { name, output } }` shape so
// a downstream `input` ref resolves without knowing which branch won (§3), and `join-applied` carries
// the winner's human `name` (§8, ADR 0007 — output keys and narration use `name`, never the GUID).
async function landWaitOneWinner(
  run: RunContext,
  node: ParallelNode,
  winner: WaitOneWinner,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { runId, rootRunId } = run.identity;
  const landed = winner.buffer;
  const publishedKeys = Object.keys(landed);
  Object.assign(exec.context, landed);
  if (publishedKeys.length > 0) await exec.onPublish(landed);
  await run.emit({
    type: "join-applied",
    runId,
    rootRunId,
    nodeId: node.id,
    nodeName: node.name,
    branches: [winner.branch.name],
    publishedKeys,
    winner: winner.branch.name,
  });
  return { status: "succeeded", output: { winner: { name: winner.branch.name, output: winner.output } } };
}

// Drain the owning workflow-run's detached `do-not-wait` branches to terminal (do-not-wait-join.md
// §2). A branch's own body may launch a further `do-not-wait` block against the *same* run while this
// await is in flight, so the loop re-checks: it drains, and any branch pushed meanwhile is caught on
// the next pass. Branch outcomes are already isolated (§5) — a failure fails nothing here — so the
// drained promises are awaited only for completion, not for their result.
async function settleDetached(run: RunContext): Promise<void> {
  while (run.detached.length > 0) {
    const pending = run.detached.splice(0);
    await Promise.all(pending);
  }
}

// Launch-and-continue (do-not-wait-join.md §2): start every branch and wait for none. Each branch runs
// against its own context snapshot (§5.3) under the run's ambient signal, so an operator abort still
// reaches it (§6), but the block does not consult its status — the branch run is pushed to the owning
// workflow-run's `detached` list and awaited only at that run's exit barrier (§1.1). A branch may not
// `publish` (load-rejected, §4), so its `onPublish` is a no-op and nothing lands. The block discharges
// at once with the empty object (§3) and its successor runs immediately; `join-applied` fires here
// carrying no `winner` and no landed keys (§9).
async function launchDoNotWait(
  run: RunContext,
  node: ParallelNode,
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { runId, rootRunId } = run.identity;
  for (const branch of node.branches) {
    const branchRun = runSequence(run, branch.body, seedInput, {
      context: { ...exec.context },
      signal: exec.signal,
      cancellation: exec.cancellation,
      onPublish: async () => {},
    }).then(() => {});
    run.detached.push(branchRun);
  }
  await run.emit({
    type: "join-applied",
    runId,
    rootRunId,
    nodeId: node.id,
    nodeName: node.name,
    branches: node.branches.map((branch) => branch.name),
    publishedKeys: [],
  });
  return { status: "succeeded", output: {} };
}

/**
 * Runs a `parallel` block (mvp spec §5.2–5.4, §5.6). Every branch runs concurrently against its own
 * snapshot of context taken at block entry (siblings never see each other's writes), and its
 * publishes buffer rather than touch the parent context mid-run. The `join` decides what lands:
 *
 * - `collect` — waits for *all* branches; a failing branch fails the block and cancels in-flight
 *   siblings (`sibling-failed`); on all-succeed every buffer lands in branch declaration order and
 *   the output is `{ "<branch-name>": <that branch's last node's output> }`.
 * - `wait-one` — races the branches; the first to `succeed` is the winner, and the still-running
 *   losers are cancelled (`sibling-succeeded`); a branch that *fails* cancels nothing and the race
 *   continues; if every branch fails the block fails with a synthetic aggregate error. Only the
 *   winner's buffer lands and the output is `{ winner: { name, output } }` (wait-one-join.md §2–§5).
 * - `do-not-wait` — launches every branch and awaits none at the join; the block discharges at once
 *   with `{}` and the successor runs while the branches keep going, awaited only at the enclosing
 *   run's exit barrier (`launchDoNotWait`, do-not-wait-join.md §2). No resume short-circuit (§7).
 */
async function runParallelNode(
  run: RunContext,
  node: ParallelNode,
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { emit, identity } = run;
  const { runId, rootRunId } = identity;

  // Launch-and-continue is join-mode dispatch, not a race variant: it shares nothing with the
  // block-local win/fail controller below, and resume is cause-blind for it (re-runs, no
  // short-circuit — §7), so it branches off before any of that is built.
  if (node.join === "do-not-wait") {
    return launchDoNotWait(run, node, seedInput, exec);
  }

  // Resume short-circuit (wait-one-join.md §7): replaying a decided race, the winner's steps reuse as
  // `succeeded` while the losers were `cancelled`. Cause-blind resume would re-run the losers — pure
  // waste, and at-least-once it could re-fire their side effects. So the join re-evaluates: find the
  // reused winner and run *only* it, starting no loser at all.
  if (node.join === "wait-one" && run.resume) {
    const reusedWinner = pickReusedWaitOneWinner(node, run.resume.plan);
    if (reusedWinner) {
      const buffer: { [key: string]: JsonValue } = {};
      const outcome = await runSequence(run, reusedWinner.body, seedInput, {
        context: { ...exec.context },
        onPublish: async (updates) => void Object.assign(buffer, updates),
      });
      // The winner reused as `succeeded` in the original tree; its replay reuses those runs and so
      // cannot do otherwise. A non-success here would be an engine bug, not a data-flow outcome.
      if (outcome.status !== "succeeded") return outcome;
      return landWaitOneWinner(run, node, { branch: reusedWinner, output: outcome.output, buffer }, exec);
    }
  }

  const controller = new AbortController();
  // A nested parallel inherits its enclosing block's cancellation: if the outer block aborts, this
  // one aborts too, so this block's own in-flight steps are killed as well.
  const outerSignal = exec.signal;
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }

  let causeRunId: string | null = null;
  let cause: Cancellation["cause"] = null;
  const cancellation: Cancellation = {
    signal: controller.signal,
    get causeRunId() {
      // Read through to the enclosing block at read time, not at block entry: an *outer* sibling
      // may fail after this block started, and its failing run is still this block's cause.
      return causeRunId ?? exec.cancellation?.causeRunId ?? null;
    },
    get cause() {
      return cause ?? exec.cancellation?.cause ?? null;
    },
    trigger(triggerRunId: string) {
      if (cause === null) {
        causeRunId = triggerRunId; // first failing sibling wins
        cause = "sibling-failed";
      }
      controller.abort();
    },
    triggerWin() {
      if (cause === null) cause = "sibling-succeeded"; // first winner wins; no cause run
      controller.abort();
    },
  };

  // The winner of a `wait-one` race: the first branch to complete `succeeded`. Because the event loop
  // serializes branch completions, the first callback to see `succeeded` here is the lowest-`seq` one
  // (§6), so no secondary tie-break is needed.
  let winner: WaitOneWinner | null = null;

  const branchResults: BranchResult[] = await Promise.all(
    node.branches.map(async (branch) => {
      // Each branch runs against a snapshot copy of context (§5.3): its publishes go to the copy
      // (so later nodes in the same branch see them) and buffer for the join — never touching the
      // parent context until the join lands them.
      const branchContext: { [key: string]: JsonValue } = { ...exec.context };
      const buffer: { [key: string]: JsonValue } = {};
      const outcome = await runSequence(run, branch.body, seedInput, {
        context: branchContext,
        signal: controller.signal,
        cancellation,
        onPublish: async (updates) => {
          Object.assign(buffer, updates);
        },
      });
      if (node.join === "collect") {
        if (outcome.status === "failed") {
          cancellation.trigger(outcome.causeRunId ?? runId); // cancel in-flight siblings best-effort
        }
      } else if (outcome.status === "succeeded" && winner === null) {
        // First to succeed wins; a losing branch's failure is ignored and cancels nothing (§2).
        winner = { branch, output: outcome.output, buffer };
        cancellation.triggerWin(); // cancel the still-running losers best-effort
      }
      return { branch, outcome, buffer };
    }),
  );

  if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);

  if (node.join === "wait-one") {
    // An outside abort (an enclosing block failing, an operator cancelling the root run) outranks a
    // local win: the whole subtree is coming down, so the winner's publishes must not land.
    if (outerSignal?.aborted) return { status: "cancelled" };
    if (winner !== null) return landWaitOneWinner(run, node, winner, exec);
    // No winner. A cancelled branch means we were aborted from outside; otherwise every branch
    // failed, and the block fails with a synthetic aggregate distinct from any one branch's error (§2).
    if (branchResults.some((r) => r.outcome.status === "cancelled")) return { status: "cancelled" };
    return { status: "failed", error: `parallel "${node.name}": all ${node.branches.length} wait-one branches failed` };
  }

  // A failing branch fails the block (and thus the run); no publishes land. Report the
  // first-declared failure for determinism.
  for (const { branch, outcome } of branchResults) {
    if (outcome.status === "failed") {
      return {
        status: "failed",
        error: `parallel "${node.name}", branch "${branch.name}": ${outcome.error}`,
      };
    }
  }
  // No local failure but a cancelled branch means the enclosing block aborted us: propagate.
  if (branchResults.some((r) => r.outcome.status === "cancelled")) {
    return { status: "cancelled" };
  }

  // All branches succeeded: land their buffered publishes at the join, in branch declaration
  // order (§5.3). Duplicate keys across siblings are already a load-time error, so no key clashes.
  const landed: { [key: string]: JsonValue } = {};
  const publishedKeys: string[] = [];
  for (const { buffer } of branchResults) {
    for (const [key, value] of Object.entries(buffer)) {
      landed[key] = value;
      publishedKeys.push(key);
    }
  }
  Object.assign(exec.context, landed);
  if (publishedKeys.length > 0) await exec.onPublish(landed);
  await emit({ type: "join-applied",
    runId,
    rootRunId,
    nodeId: node.id,
    nodeName: node.name,
    branches: branchResults.map((r) => r.branch.name),
    publishedKeys,
  });

  // Collect output: keyed by branch name in declaration order, deterministic regardless of
  // completion order and dot-path addressable (§5.4, ADR 0007 — output keys are the human `name`).
  const output: { [key: string]: JsonValue } = {};
  for (const { branch, outcome } of branchResults) {
    output[branch.name] = outcome.status === "succeeded" ? outcome.output : null;
  }
  return { status: "succeeded", output };
}
