import { randomUUID } from "node:crypto";
import { findRootRun, formatIssues, isStepType, rerunBoundaryIndex, rerunDisposition, walkNodes, type BranchNode, type CheckpointNode, type GotoNode, type ConfigObject, type ControllerType, type JsonValue, type LaunchFacts, type RerunFromNodePathEntry, type RunRecord, type WhileDoNode, type WorkflowFile } from "@path/schema";
import { z } from "zod";
import { resolveChildRef, walkRefTree } from "./ref-tree.js";
import {
  buildSuppressSet,
  childResumeState,
  continuationOf,
  firstRecordedChild,
  readExistingOutput,
  recordedPasses,
  resolveRerunFromNodePath,
  targetLeafUnder,
} from "./continuation.js";
import { rootCancellation, stopCause } from "./cancellation.js";
import { buildLaunchFacts, describeMissingLaunchSecrets } from "./launch-facts.js";
import { findNestedCounterpart, planReuse } from "./plan-reuse.js";
import { descendNodePath } from "./descend-node-path.js";
import { runParallelNode, settleDetached } from "./run-parallel.js";
import { RUN_BLOB_FILE } from "./persistence/paths.js";
import { describeConditionFailure, evaluateCondition, type Trace } from "./condition.js";
import {
  type Cancellation,
  type ContinueState,
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
import { describeUnsetEnv, type EnvSource, resolveEffectiveConfig, resolveRunEnv } from "./resolve-env.js";
import { ObserverError, type RunObserver } from "./run-observer.js";
import { collectSecrets, maskObservation, type SecretMasker } from "./secret-mask.js";

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
   * The operator's **override input** as they supplied it (ADR 0046) — the pre-fallback seed, where
   * `input` is the effective one (override, else the file's own seed, else `{}`). Recorded with the
   * other launch facts and shown to a reader; never re-applied on a continuation, because Resume and
   * Complete restore the context blackboard rather than re-seeding from input.
   */
  operatorInput?: JsonValue;
  /**
   * Frozen launch-config secrets the continuation did **not** supply again (ADR 0046) — dot-paths the
   * predecessor recorded as `$secret`, whose frozen value is therefore a `[secret:<key>]` token. The
   * run ends before its first step naming them, the same shape as an unset `$env`. Set by
   * `Project.resume`/`complete` from the frozen facts; a launch never sets it.
   */
  unresolvedLaunchSecrets?: string[];
  /**
   * The `secretKeys` a continuation inherited from the frozen facts (ADR 0046). Its recovered config
   * is already unwrapped, so the wrappers that marked those paths are gone — passing them through here
   * is what keeps the successor's own frozen copy honest about which of its values are secrets.
   */
  inheritedLaunchSecretKeys?: string[];
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
   * 0019 sub-2). The acceptance run's scripted `prompt`/`anthropic` worker plugs in here; a live run passes
   * nothing and every leaf runs on its shipped worker.
   */
  workerOverrides?: WorkerOverrides;
  /**
   * The **launch** worker-default table (ADR 0044): a `{ <stepType>: <workerName> }` map the operator
   * supplies at launch (the CLI's repeatable `--worker-default <type>=<name>`, the server's top-level
   * `worker_defaults` body field). It picks the worker for a type's un-pinned steps run-wide — every
   * file of the tree, child refs included — sitting above the file-scoped `file.worker_defaults` and
   * below an explicit `node.worker` pin (four-tier dispatch). Frozen for the run: unlike the file
   * table, it is not re-read per file. Absent when the operator supplied none. Its registry-relative
   * validity is a launch-boundary concern (#506), checked before the run rather than in this dispatch.
   */
  launchWorkerDefaults?: { [stepType: string]: string };
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
   * Complete an awaiting leaf by replaying the **existing** tree in place (ADR 0041). Distinct from
   * `resume` (which mints a fresh successor tree): the re-invocation re-enters this same tree's runs by
   * their own ids, reuses every `succeeded` row read-only, reaches the parked leaf named by
   * `target.stepRunId`, transitions it `awaiting → succeeded` with `target.output`, and appends forward
   * under the same root. Mutually exclusive with `resume`. `Project.complete` is the one authority that
   * builds it (loads the tree, pre-swaps reuse rows, takes the lease, validates the leaf).
   */
  continue?: ContinueInput;
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
  /** Loads one blob of an original run by filename (`RUN_BLOB_FILE.output` / `.input`). */
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  /**
   * The **rerun boundary (K)** as the descent path of node ids root→…→K (ADR 0032/0036). `[]` or
   * undefined is **plain Resume** (K at the auto-boundary); length 1 is a top-level K (ADR 0035); a
   * longer path descends into nested `workflow` files, its head a top-level node of the root file and
   * each subsequent id a top-level node of the previous path-node's file. `Project.resume` is the one
   * authority that resolves the operator's source run id to this path and validates it against the
   * current file before any successor starts — the engine trusts it and only backstops with a throw.
   */
  rerunFromNodePath?: string[];
  /**
   * Beside `rerunFromNodePath`, level for level: the goto pass (1-based) K's path-node sits in at that
   * level, or `null` for a level whose file holds no goto (ADR 0054 §6). Absent when no level has one.
   */
  rerunFromPasses?: (number | null)[];
}

/**
 * What a Complete re-invocation needs to replay the appendable tree (ADR 0041). Built by
 * `Project.complete`; the engine core does no I/O, so the tree rows and a blob reader are supplied.
 *
 * - `rootRunId` is the tree being continued — the re-invocation keeps this id, minting no successor.
 * - `existingRuns` is every run row of that tree, with reuse rows already swapped for their source
 *   record (so a `succeeded` row addresses its own output blob), matching `ResumeInput.originalRuns`.
 * - `readBlob` loads a blob (an existing run's `output.json`, a re-entered run's `context.json`).
 * - `target` names the parked leaf's step-run id and the validated output to write on its transition.
 */
export interface ContinueInput {
  rootRunId: string;
  existingRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  target: { stepRunId: string; output: JsonValue };
}

// Shaped differently from @path/schema's success/failure results: a failed run still carries
// the last-succeeded node's output (useful to a caller even on failure), so `output` is
// unconditional rather than living only in a success branch.
export interface RunResult {
  // `cancelled` is a run whose leaf steps the engine killed best-effort (mvp spec §5.6): because a
  // sibling parallel branch failed (#24), or because an operator aborted `RunOptions.signal` (#52) —
  // which any run in the tree, the root included, may end on.
  //
  // `awaiting` is **not** a terminal status: the run reached a person-activity leaf and tore down
  // (ADR 0039/0041). Its root row stays `running` (no `run-finished` was emitted) and the tree is
  // reopened by a later Complete replay. A caller reads it as "the run parked, do not treat it as an
  // outcome" — the CLI reports it, and the server does not log it as a failure.
  status: "succeeded" | "failed" | "cancelled" | "awaiting";
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
   * `$env` variables (#116) and unrecovered launch secrets (ADR 0046). The run is still started and
   * recorded; see `runBody`.
   */
  runStartFailure?: string;
  /**
   * The frozen launch facts this **root** run records on its `run-started` (ADR 0046): the operator's
   * input override, resolved+masked config override, and launch worker-default table. Root-only —
   * a nested workflow-run's params never carry it — and absent when the launch supplied none.
   */
  launchFacts?: LaunchFacts;
  // Shared by the entire run tree, so the registry and processor cap span nested runs too (mvp spec §5.5).
  runtime: StepRuntime;
  // A nested workflow-run inside a `parallel` branch inherits the block's cancellation, so its own
  // leaf steps are killed too when a sibling branch fails (mvp spec §5.6). A `workflow` step passes its
  // own execution's authority straight through, so the whole tree shares the chain rooted at the root
  // run's authority (`cancellation.ts`) — the operator's stop and every sibling cause included.
  signal?: AbortSignal;
  cancellation?: Cancellation;
  // Resume this workflow-run against the original tree (#172): the whole-tree read inputs plus this
  // run's own original counterpart (the run it corresponds to, if any). Absent for a fresh run.
  // `rerunSuffix` is the Resume-from-K rerun boundary as a per-level remaining descent path (ADR 0036):
  // the root run carries the whole path, each descent hands the path-node its `slice(1)` tail, and
  // every off-path sibling hands `[]`, so suppression reaches exactly the on-path level at each depth.
  resume?: { input: ResumeInput; counterpart: RunRecord | undefined; rerunSuffix: string[]; rerunPasses: (number | null)[] };
  // Complete-continue over the appendable tree (ADR 0041): the shared continue state plus **this**
  // run's own existing row. `existing` defined means the run is re-entered in place — its row already
  // exists, so no `run-started` is emitted and its context is restored from its own `context.json`; on
  // success it emits `run-finished`, transitioning the row `running → succeeded`. `existing`
  // undefined (in continue mode) is a fresh run appended forward past the parked leaf — an ordinary
  // `run-started`/`run-finished` pair under the same root. Absent entirely on launch and Resume.
  continue?: { state: ContinueState; existing: RunRecord | undefined };
  // The rerun boundary (K) descent path as `{nodeId, nodeName}[]` (#444, ADR 0032), threaded only
  // into the root run's params — a read denormalization persisted on the root row's
  // `rerun_from_node_path`. Absent on plain Resume and on every nested run.
  rerunFromNodePath?: RerunFromNodePathEntry[];
  // The predecessor's root run id, stamped on this run's `run-started` (#173). Set only on the root
  // run of a resumed tree — a nested run's predecessor is the tree's, not its own, so it never
  // carries one. It is the successor-identity fact persistence records on the root row.
  resumedFromRootRunId?: string;
  // The root workflow's store-relative path (#202), threaded only into the root run's params — a
  // nested workflow-run is started by `runWorkflowNode`, which never sets it, so it stays root-only.
  sourceWorkflowPath?: string;
}

type WorkflowNode = WorkflowFile["body"][number];
type ControlNode = Extract<WorkflowNode, { type: ControllerType }>;

// The five engine-evaluated control constructs — everything the node walker owns itself, with no run
// of its own (CONTEXT invariant 1). `workflow` is *not* here: it runs a nested workflow-run, so it
// takes the step path beside the leaf types. A `type` that is not a controller is a step — `binary`,
// `prompt`, `workflow`, or any plugin folder — dispatched through the registry (ADR 0019 sub-10). The
// controller set is `@path/schema`'s (`isStepType`, derived from the node union), so this guard and
// the reuse plan's cannot drift: `ControllerType` is exactly what `isStepType` excludes.
function isControlNode(node: WorkflowNode): node is ControlNode {
  return !isStepType(node.type);
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

  // Resume (#172, ADR 0062): a re-entered workflow-run starts its context blackboard from its seed —
  // what its counterpart started from — and the reused prefix re-publishes in walk order, so every
  // node sees the context it saw originally (replay from seed). The counterpart's final
  // `context.json` is never the start: under Resume-from-K it holds keys written after K, which would
  // leak into K's view. A root Resume carries no input of its own, so its seed is the counterpart's
  // recorded `input.json`. A nested run's own `input` is already its seed: the parent replayed to the
  // same context, so the interpolation reproduces the recorded one — with real secret values, where
  // the recorded blob holds mask tokens. A run with no counterpart — added since — is a first
  // attempt and seeds fresh (invariant 4). A `while-do` body's runs now each sit under their own
  // per-iteration container (ADR 0037, #454), so an iteration is told apart by ordinal and its body
  // re-enters the matching counterpart; `runWhileDoNode` supplies that counterpart via the container's
  // own resume state. The reuse plan is this run's own, scoped to its counterpart's children.
  const resumeCounterpart = params.resume?.counterpart;
  // Complete-continue (ADR 0041): a re-entered run of the tree being Completed (`continue.existing`
  // defined) restores its context from its **own** `context.json` in this same tree — the blackboard
  // as it stood when the run parked. Complete has no rerun boundary, so the parked blackboard is
  // already the exact state to continue from — it keeps restore-by-load where Resume replays.
  const continueReenter = params.continue?.existing;
  const seed =
    params.resume && resumeCounterpart && identity.parentRunId === null
      ? (params.resume.input.readBlob(resumeCounterpart, RUN_BLOB_FILE.input) as { [key: string]: JsonValue })
      : input;
  const parkedContext =
    params.continue && continueReenter
      ? (params.continue.state.readBlob(continueReenter, RUN_BLOB_FILE.context) as { [key: string]: JsonValue })
      : undefined;
  const context: { [key: string]: JsonValue } = { ...(parkedContext ?? seed) }; // format doc §6.3
  // Producer A (ADR 0036): at every on-path level the level's own `suppress` set (this run's suffix
  // head B and every serialized-later run-producing id, over this file's own body) is dropped from the
  // plan, so B and after-B re-run instead of reusing. Off-path (`rerunSuffix` empty) it is undefined,
  // so `planReuse` is the plain-Resume one — the reuse producer keyed off this run's own suffix, not
  // `parentRunId === null`, which is what lets suppression reach a descended child's `planReuse`.
  const rerunSuffix = params.resume?.rerunSuffix ?? [];
  const suppress = buildSuppressSet(file, rerunSuffix);
  const resume: RunResume | undefined = params.resume
    ? {
        input: params.resume.input,
        counterpart: resumeCounterpart,
        plan: resumeCounterpart
          ? planReuse(params.resume.input.originalRuns, file, resumeCounterpart.runId, suppress)
          : new Map(),
        rerunSuffix,
        rerunPasses: params.resume.rerunPasses,
      }
    : undefined;
  let previousOutput: JsonValue = seed;

  // At the file boundary the incoming (operator or parent-effective) config shadows this file's
  // declared defaults key by key, nearest wins (format doc §8). One of the two points a run
  // materializes effective config, so one of the two that resolve `$env` and unwrap `$secret`
  // (#116, ADR 0022 sub-4) — what survives the merge is what every reader downstream sees: the
  // run-start gate, interpolation, conditions and the worker, with no wrapper left in it.
  // Idempotent, so the already-effective incoming half is untouched.
  const fileConfig = resolveEffectiveConfig(mergeConfig(file.config ?? {}, incomingConfig), params.env);
  const run: RunContext = { file, fileDir, fileConfig, identity, emitter, files, env: params.env, runtime: params.runtime, resume, continue: params.continue?.state, detached: [] };
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
    //
    // Complete-continue re-entry (ADR 0041): a run re-entered in place already has its row and its
    // `context.json` in this tree — it was `running`, never terminal, so nothing was frozen. Emitting
    // a second `run-started` would insert a duplicate row, and rewriting `context.json` from the
    // restored blackboard would be a no-op write, so both are skipped. A *fresh* run appended forward
    // past the parked leaf (`continue.existing` undefined) is an ordinary run and takes this path.
    if (continueReenter === undefined) {
      await emitter.runStarted({
        // The seed, not the raw `input`: a resumed root's own `input` is empty, and recording the seed
        // is what lets a Resume of this successor replay from the same seed again (ADR 0062).
        input: seed,
        resumedFromRootRunId: params.resumedFromRootRunId,
        // The rerun boundary (K) path, root-only (#444): the emitter gates it on `isRoot`, so a nested
        // run passing undefined here changes nothing.
        rerunFromNodePath: params.rerunFromNodePath,
        // The frozen launch facts, root-only (ADR 0046): recorded on the root row so a later
        // resume/Complete recovers the config and worker table, and so the run tree can show what the
        // launch supplied. The emitter gates the field on `isRoot`, so a nested run drops it.
        launchFacts: params.launchFacts,
        workflowId: file.id,
        workflowName: file.name,
        workflowPath: params.sourceWorkflowPath,
      });
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

    // The whole body is one top-level walk against this run's own context; a top-level publish is a
    // context write-through (mvp spec §6). The implicit root step's default input is the workflow
    // input (format doc §6.1).
    const outcome = await runTopLevelWalk(run, input, {
      context,
      signal: params.signal,
      cancellation: params.cancellation,
      onPublish: async () => {
        await emitter.contextChanged(context);
      },
      // The run's walk, handed to every construct below (a `parallel` branch, a loop body, a branch
      // arm) instead of each importing it back — see `NodeExecContext.walk`.
      walk: runSequence,
    });
    // The run reached a person-activity leaf and parked (ADR 0039/0041): it neither succeeded nor
    // failed, so it emits no terminal `run-finished` and this row stays `running`. The tree is
    // reopened by a later Complete replay, which re-enters this same run and drives it forward. We
    // return before the detached barrier: the run is not finishing, so its do-not-wait branches keep
    // running under it and are drained only when a Complete actually settles it.
    if (outcome.status === "awaiting") return { status: "awaiting", output: previousOutput };
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
  /**
   * The existing row of *this* tree this nested run re-enters in place, when a Complete replay
   * reached it (ADR 0041) — the continuation adapter's `reenter`. Undefined on a fresh forward run,
   * which mints its own id. The lookup lives there, not here, so every walker answers "does this node
   * already have a run" the same way.
   */
  existingRun?: RunRecord,
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
  const child = resolveChildRef(ctx.run.fileDir, node.ref, ctx.run.files);
  if (!child) {
    return { status: "failed", error: `workflow step "${node.name}": referenced file "${node.ref}" is not in the loaded tree` };
  }

  // A nested run still `running` in the tree being Completed is re-entered **in place** (ADR 0041) —
  // same run id, no `run-started` — so its parked descendants resolve under the identity they already
  // have. `runNode` passed that row in from the continuation adapter; a node with none is a fresh
  // forward run appended past the parked leaf, minting an id like any launch run.
  const childIdentity: RunIdentity = {
    runId: existingRun?.runId ?? randomUUID(),
    rootRunId: ctx.run.identity.rootRunId,
    parentRunId: ctx.run.identity.runId,
    nodeId: node.id,
    nodeName: node.name,
  };
  const childResult = await executeWorkflowRun({
    file: child.file,
    fileDir: child.dir,
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
    // Continue this child in place when the tree is being Completed (undefined otherwise): its own
    // existing row (re-enter) or undefined (fresh forward run under the same root).
    continue: ctx.run.continue ? { state: ctx.run.continue, existing: existingRun } : undefined,
    // Resume recurses into every non-succeeded workflow-run, not just the root (#172,
    // resume-restore-semantics.md §2): the child re-enters against its own original counterpart, so
    // its already-succeeded grandchildren reuse rather than re-running from scratch. Producer B (ADR
    // 0036) chooses the child's disposition from this level's own suffix — reuse/off-path, rerun-entire,
    // or descend — and threads the tail only into a descended path-node (`childResumeState`).
    resume: childResumeState(ctx.run, node.id),
  });

  if (childResult.status === "cancelled") return { status: "cancelled" };
  // The nested run parked at a person-activity leaf (ADR 0041): it stays `running`, and this
  // `workflow` step's own run *is* that child run (invariant 2), so it parks too. The `awaiting`
  // propagates up unchanged — no enclosing run finishes.
  if (childResult.status === "awaiting") return { status: "awaiting" };
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
  if (result.status !== "awaiting" && result.stderr !== undefined) await step.stderr(result.stderr);

  // 2. The engine owns `cancelled`, derived from the signal rather than the worker's reported status,
  // and the cause from the cancellation authority (`cancellation.ts`) rather than re-reading it here.
  if (signal?.aborted) {
    await step.cancelled(stopCause(cancellation));
    return { status: "cancelled" };
  }

  // 2b. A worker that returned `awaiting` (person-activity) parks the leaf and the engine tears down
  // (ADR 0039/0041): no held process, no in-memory deferred. The step transitions running -> awaiting
  // (emitted as `step-awaiting`, persisted with no `finished_at`) and the walk stops here — the
  // `awaiting` outcome propagates up like a non-success, leaving every enclosing run `running`. The
  // parked leaf is resolved later by a Complete replay from the root (ADR 0041), which reaches this
  // same leaf run and writes its output through the CAS, never through this call.
  if (result.status === "awaiting") {
    // The worker's echoed `assignee` (#488) rides the `step-awaiting` record; a park that named none
    // carries `null`. The engine reads it as an opaque string, masked at the emit choke point.
    await step.awaiting({ assignee: result.assignee ?? null });
    return { status: "awaiting" };
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
  return finishSucceeded(step, node, result.output);
}

/**
 * The shared success tail: apply `parse: "json"` to a string output, then emit the succeeded finish.
 * Both a worker's own success (section 5) and an awaiting step's external completion (#462) land
 * here, so a person-activity node declaring `parse: "json"` gets the same parsing a leaf worker does.
 */
async function finishSucceeded(
  step: StepEmitter,
  node: SettleStepResult["node"],
  rawOutput: JsonValue,
): Promise<SeqOutcome> {
  let output: JsonValue = rawOutput;
  if (node.parse === "json" && typeof rawOutput === "string") {
    try {
      output = parseStepOutput(rawOutput);
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
  // Four-tier dispatch resolution (ADR 0044), first hit wins: a step's explicit `worker` pin; the
  // operator's run-wide `launchWorkerDefaults[type]`; the owning file's `worker_defaults[type]`; the
  // plugin's own `defaultWorker`. The two default tiers differ by scope: the **launch** table lives on
  // the run tree's shared `runtime`, so it reaches every un-pinned step of every file — a nested
  // `workflow`-ref run swaps `file` but keeps `runtime`, so a launch default beats a *child's* file
  // default too (the operator's run-wide intent outranks an author's per-file default; only a
  // `node.worker` pin sits above it). The **file** table lives on `ctx.run.file`, the file that owns
  // this node, so it stays file-scoped for free (it never crosses a ref boundary). Both are a
  // *selection* by name; registry-relative validity is checked elsewhere per tier (#506) — until those
  // nets exist, a table naming a worker the type does not ship falls through to the `has no worker`
  // failure just below, loud not silent.
  const workerName =
    node.worker ??
    ctx.run.runtime.launchWorkerDefaults?.[node.type] ??
    ctx.run.file.worker_defaults?.[node.type] ??
    plugin.defaultWorker;
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

  const release = descriptor.needsProcessorSlot ? await ctx.run.runtime.semaphore.acquire() : undefined;
  try {
    // The step's run id is minted (and its row starts) only once any processor slot is really held.
    const step = ctx.run.emitter.step(node);
    ctx.onLeafStep?.(step);
    await step.started({ stepType: node.type, workerName, input: stepInput });

    const request: StepRequest = {
      fields: fields as StepRequest["fields"],
      input: stepInput,
      // The worker reads real values: the effective config is what it is — `$env` resolved and
      // `$secret` unwrapped where the config was materialized (ADR 0022 sub-4, `resolveEffectiveConfig`).
      // Masking stays a persistence-boundary concern only (ADR 0020).
      config: ctx.stepConfig as unknown as StepRequest["config"],
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
  // A Complete re-invocation (ADR 0041) keeps the tree's own root run id — it appends in place and
  // mints no successor. A launch or Resume mints a fresh root id.
  const runId = options.continue?.rootRunId ?? randomUUID();

  // One snapshot for the whole run (#116). The environment is read here and nowhere else, so a
  // variable changed mid-run cannot make a step's config disagree with what the masker collected
  // from the same wrapper at run start.
  const env: EnvSource = { ...process.env };

  // The frozen executor registry for this run: the load's own scanned registry (ADR 0019 sub-15),
  // or — for a caller with no load — a folder scan here, with `workerOverrides` merged over whichever
  // one replace-only (ADR 0021 sub-15). Leaf dispatch reads it — `registry[type].workers`. Built
  // before the run-start analysis, whose config gate validates each leaf against its type's fragment.
  const registry = await resolveExecutorRegistry(options.registry, options.workerOverrides, options.stepPluginsDir);

  // The whole run-start read of the config tree, behind one seam (#116, #20, ADR 0022 sub-3): collect
  // every config object, resolve `$env`, collect `$secret` into the masker, and gate the run — unset
  // `$env` named first, else config-fragment validation. The staging is load-bearing and lives inside
  // `analyzeRunStart`; here it is one call yielding the two facts the rest of the run needs — the
  // masker (used at the emit choke point below and the mask-on-return) and the run-start failure.
  const { masker, runStartFailure } = analyzeRunStart(file, fileDir, options, env, registry);
  for (const warning of masker.warnings) options.warn?.(warning);

  // What the operator supplied at launch, frozen for this tree (ADR 0046): assembled once, here, from
  // the same options the run executes with, so the recorded facts and the executed config cannot drift.
  // `inheritedLaunchSecretKeys` rides along on a continuation, whose config arrived already unwrapped.
  const launchFacts = buildLaunchFacts(
    { input: options.operatorInput, config: options.operatorConfig, workerDefaults: options.launchWorkerDefaults },
    env,
    options.inheritedLaunchSecretKeys ?? [],
  );

  const { observer } = options;

  // The original tree's own root run (`parentRunId === null`), found once: it is both the root run's
  // resume counterpart (#172) and — being the predecessor of this fresh root run — the successor
  // identity fact stamped on its `run-started` (#173).
  const originalRoot = findRootRun(options.resume?.originalRuns ?? []);
  const emit: Emit = observer
    ? async (o) => {
        await observer.observe(masker.isEmpty ? o : maskObservation(masker, o));
      }
    : async () => {};

  // The tree's one masking sink becomes the root run's emitter here; every descendant run gets its
  // own via `emitter.child`, so `emit` itself never travels past this call.
  const rootIdentity: RunIdentity = { runId, rootRunId: runId, parentRunId: null, nodeId: null, nodeName: null };
  // The tree's root **cancellation authority** (`cancellation.ts`): the operator's signal, and the only
  // cause an outside stop has. The run's own signal is that authority's, so the operator stop and the
  // cause a killed leaf narrates come from one object rather than a signal here and a guess at the leaf.
  const rootAuthority = rootCancellation(options.signal);
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
      launchFacts,
      // External abort (#52): the operator's signal is the root run's own, chained into the tree's root
      // **cancellation authority** (`cancellation.ts`), which every `parallel` block below extends.
      signal: rootAuthority.signal,
      cancellation: rootAuthority,
      // One registry and one semaphore for the whole run tree: the cap is engine-wide, spanning
      // nested workflows and nested parallels alike (mvp spec §5.5).
      runtime: {
        registry,
        semaphore: createProcessorSemaphore(options.processorConcurrency ?? DEFAULT_PROCESSOR_CONCURRENCY),
        // The operator's run-wide launch worker-default table (ADR 0044), shared by the whole tree so a
        // nested `workflow`-ref run — which keeps `runtime` but swaps `file` — reads the same table.
        launchWorkerDefaults: options.launchWorkerDefaults,
      },
      // Resume (#172): the root run's original counterpart is the original tree's own root run.
      // From there `executeWorkflowRun` plans reuse and restores context, recursing into every
      // non-succeeded nested workflow-run. `rerunSuffix` seeds the whole Resume-from-K descent path
      // (ADR 0036) at the root; each level slices its own head off before handing the tail down, and
      // an empty path is plain Resume. `Project.resume` validated it against this file already.
      resume: options.resume
        ? {
            input: options.resume,
            counterpart: originalRoot,
            rerunSuffix: options.resume.rerunFromNodePath ?? [],
            rerunPasses: options.resume.rerunFromPasses ?? [],
          }
        : undefined,
      // Complete-continue (ADR 0041): the root run is re-entered in place — its own row is the
      // `existing` one, so `executeWorkflowRun` skips its `run-started` and restores its context from
      // this same tree. The walk then reuses succeeded rows, resolves the parked leaf, and appends
      // forward. Mutually exclusive with `resume`.
      continue: options.continue
        ? { state: { existingRuns: options.continue.existingRuns, readBlob: options.continue.readBlob, target: options.continue.target }, existing: findRootRun(options.continue.existingRuns) }
        : undefined,
      // The rerun boundary (K) descent path, denormalized to `{nodeId, nodeName}[]` for the root row
      // (#444, ADR 0032). Undefined on plain Resume, which leaves `rerun_from_node_path` null.
      rerunFromNodePath: options.resume
        ? resolveRerunFromNodePath(file, fileDir, options.files, options.resume.rerunFromNodePath, options.resume.rerunFromPasses)
        : undefined,
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

/** The two run-start facts the analysis yields: the masking sink, and the failure that ends the run before its first node (if any). */
export interface RunStartAnalysis {
  /**
   * The `$secret` masking sink built from the run's whole resolved config (mvp spec §8.3, #20). It
   * escapes the analysis because it lives past run start: it is the emit choke point's masker and the
   * one that scrubs what a finished run returns. Its `warnings` are the caller's to surface.
   */
  masker: SecretMasker;
  /**
   * The run-start gate's verdict (#116, ADR 0022 sub-3): `undefined` to proceed, else the message the
   * run ends `failed` on before its first node. Names unset `$env` variables, or config-fragment
   * mismatches — never both, because the first pre-empts the second (see below).
   */
  runStartFailure?: string;
}

/**
 * The run's whole read of its config tree at start, in one place (#116, #20, ADR 0022 sub-3). It exists
 * so `runWorkflow` reads run-start as a single fact rather than four scattered statements, and so the
 * gate's staging — which is load-bearing — has one owner and one test surface.
 *
 * **Four passes, in a fixed order, and why they are not one.** The order is the point, not an accident:
 *
 * 1. **Collect** every config object across the whole tree, unmerged (`collectRunConfigs`) — whole-tree
 *    because a `$env` a parent's config shadows must still be set, and a `$secret` anywhere must still be
 *    masked (its comment carries the reasoning).
 * 2. **Resolve `$env`** over that set (`resolveRunEnv`), *before* collecting secrets: masking is by value
 *    (§8.3), so `{"$secret": {"$env": "TOKEN"}}` must already carry the real value or the masker collects
 *    the literal `TOKEN` and the credential reaches disk unmasked. Unset variables surface here.
 * 3. **Collect `$secret`** from the resolved set into the masker (`collectSecrets`).
 * 4. **Validate** each leaf's effective, merged, resolved config against its type's fragment
 *    (`validateRunStartConfig`) — but *only if* no `$env` was unset: config cannot be validated against
 *    values it could not resolve, so an unset variable pre-empts the fragment check.
 *
 * Passes 1 and 4 both walk the tree, but compute different things — 1 flattens raw config pre-resolution,
 * 4 merges effective config per leaf post-resolution — and 4 is gated on 2's result. Folding them into
 * one traversal would entangle collection with validation and lose the "resolve every `$env` first, then
 * validate" staging, so they stay distinct passes behind this one door rather than one merged walk.
 */
export function analyzeRunStart(
  file: WorkflowFile,
  fileDir: string,
  options: RunOptions,
  env: EnvSource,
  registry: LoadedStepPluginRegistry,
): RunStartAnalysis {
  const configs = collectRunConfigs(file, options);
  const { configs: resolvedConfigs, unset } = resolveRunEnv(configs, env);
  const masker = collectSecrets(resolvedConfigs);
  const runStartFailure =
    unset.length > 0
      ? describeUnsetEnv(unset)
      : (options.unresolvedLaunchSecrets?.length ?? 0) > 0
        ? describeMissingLaunchSecrets(options.unresolvedLaunchSecrets as string[])
        : validateRunStartConfig(file, fileDir, options.files, options.operatorConfig ?? {}, env, registry);
  return { masker, runStartFailure };
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

  // One descent of the loaded ref tree (`walkRefTree`), so this gate reads the very `stepConfig` the
  // executor materializes. A file reached under two parents is validated once per incoming config, each
  // against what actually reaches it (format §8) — the walk carries that, not this fold.
  for (const { node, stepConfig } of walkRefTree(rootFile, rootDir, { files, operatorConfig, env })) {
    if (node.type === "workflow") continue; // grammar-fixed, never a registry leaf; the walk descends it
    const plugin = registry[node.type];
    if (!plugin) continue; // the schema already rejects a type no registry contributes
    const result = z.object(plugin.config).passthrough().safeParse(stepConfig);
    if (!result.success) {
      for (const issue of formatIssues(result.error)) {
        issues.push(`step "${node.name}" (type ${node.type}): ${issue}`);
      }
    }
  }

  if (issues.length === 0) return undefined;
  return `run failed before its first step: ${
    issues.length === 1 ? "config validation failed" : `${issues.length} config validation errors`
  }: ${issues.join("; ")}`;
}

/** A node found by id in a loaded ref tree, with the effective config that reaches it. */
export interface ResolvedNode {
  /** The node exactly as it stands in the current file. */
  node: WorkflowNode;
  /**
   * The `config` scope a caller interpolates this node's fields against — the file's config merged
   * with the node's own, `$env`-resolved and `$secret` unwrapped (`resolveEffectiveConfig`), exactly
   * the object `runLeafStep` hands `configScope` when it interpolates fields at execution time.
   */
  config: ConfigObject;
}

/**
 * Locate a node by its durable GUID `id` across the loaded ref tree, threading effective config
 * across each `workflow` boundary exactly as the run will (`validateRunStartConfig`, format §8) — so
 * the config a caller interpolates a field against here is the one the run itself used. `undefined`
 * when no reachable file carries a node with that id (the author deleted it mid-wait).
 *
 * The Complete route (#485) reads a parked `person-activity` leaf's `outputSchema` through this,
 * re-interpolates it against config, and ajv-validates the submitted output (ADR 0040) — all before
 * any lease is taken, so a bad submit never blocks a sibling leaf.
 */
export function resolveNode(
  rootFile: WorkflowFile,
  rootDir: string,
  nodeId: string,
  options: { files?: Map<string, WorkflowFile>; operatorConfig?: ConfigObject; env?: EnvSource } = {},
): ResolvedNode | undefined {
  // The one descent of the loaded tree (`walkRefTree`), so the config a caller interpolates this node's
  // fields against is the object dispatch hands the worker — one rule, not a second copy of it. The
  // caller owns the environment snapshot (`RunOptions`/`Project`), because a reader that takes its own
  // `process.env` here would judge the node against config the run never used.
  const scope = {
    files: options.files,
    operatorConfig: options.operatorConfig,
    env: options.env ?? { ...process.env },
  };
  for (const entry of walkRefTree(rootFile, rootDir, scope)) {
    if (entry.node.id === nodeId) return { node: entry.node, config: entry.stepConfig };
  }
  return undefined;
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

/**
 * The resume state for one `while-do` iteration container (ADR 0037, #454), or `undefined` to run the
 * iteration fresh. Reuse applies only when three things hold: the enclosing run is resuming against a
 * counterpart, the loop is **not** in a Resume-from-K rerun region (K at or after it — the whole loop
 * re-runs entire then), and that counterpart has a **succeeded** iteration container with this ordinal.
 * The container's plan is scoped to that counterpart, whose only run-producing child is the loop body,
 * so the body reuses whole; a body that did not reuse re-enters its own counterpart through the
 * container scope, where `findNestedCounterpart` is now unambiguous — one body run per container.
 */
function loopIterationResume(run: RunContext, node: WhileDoNode, iteration: number): RunResume | undefined {
  const resume = run.resume;
  if (!resume || !resume.counterpart) return undefined;
  // A loop at or after this level's rerun boundary re-runs entire (ADR 0036), so every iteration is
  // fresh; off-path / plain Resume leaves it in the reuse region. One authority for the verdict
  // (`@path/schema/rerunDisposition`) — reuse is the only disposition that keeps the loop reusing.
  if (rerunDisposition(run.file.body, resume.rerunSuffix, node.id) !== "reuse") return undefined;
  const counterpart = resume.input.originalRuns.find(
    (r) =>
      r.parentRunId === resume.counterpart!.runId &&
      r.nodeId === node.id &&
      r.iteration === iteration &&
      r.status === "succeeded",
  );
  if (!counterpart) return undefined;
  return {
    input: resume.input,
    counterpart,
    // Scoped to the container: its only run-producing child is the loop body, so the plan holds just
    // that node — the whole point of the per-iteration scope (uniqueness restored one level down).
    plan: planReuse(resume.input.originalRuns, run.file, counterpart.runId),
    rerunSuffix: [],
    rerunPasses: [],
  };
}

/**
 * One `while-do` iteration as its own run scope (ADR 0037, #454): a container run under the enclosing
 * run, with the loop body dispatched **inside** it so the body's runs get a unique parent — which is
 * what lets a completed loop reuse across Resume. The container does **not** isolate context: `exec`
 * (the loop's shared blackboard) is threaded through unchanged, so the condition and the cross-iteration
 * default-input chain keep reading and writing the enclosing run's context. This is the one way it
 * differs from a nested `workflow` step's run.
 */
async function runLoopIteration(
  run: RunContext,
  node: WhileDoNode,
  iteration: number,
  iterationInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  // Complete-continue (ADR 0041): the continuation adapter answers what this iteration's recorded row
  // means — a `succeeded` container is reused read-only (its recorded output threads the loop's
  // default-input chain and the body is not re-walked), a `running` one is the parked iteration,
  // re-entered in place (same id, no `run-started`), and none means a fresh iteration appended past
  // the parked leaf.
  const disposition = continuationOf(run).disposition(node, iteration);
  const continuing = run.continue;
  if (continuing && disposition.kind === "succeeded") {
    return { status: "succeeded", output: readExistingOutput(continuing, disposition.existing) };
  }
  const existingContainer = disposition.kind === "reenter" ? disposition.existing : undefined;
  const containerIdentity: RunIdentity = {
    runId: existingContainer?.runId ?? randomUUID(),
    rootRunId: run.identity.rootRunId,
    parentRunId: run.identity.runId,
    nodeId: node.id,
    nodeName: node.name,
    iteration,
  };
  const containerEmitter = run.emitter.child(containerIdentity);
  // A re-entered running container already has its row; a fresh iteration starts one.
  if (existingContainer === undefined) await containerEmitter.runStarted({ input: iterationInput });

  // The container reuses this run's file/config/env/runtime/detached/continue, swapping only its
  // identity, emitter, and resume state; `exec` (the shared context) is passed unchanged so the body
  // publishes into the loop's context, not a fresh one.
  const containerRun: RunContext = {
    ...run,
    identity: containerIdentity,
    emitter: containerEmitter,
    resume: loopIterationResume(run, node, iteration),
  };
  // The loop body is a single node (`@2` §4.3), run as a one-node sequence inside the container.
  const outcome = await runSequence(containerRun, [node.node], iterationInput, exec);
  // The body parked at a person-activity leaf (ADR 0041): the container stays `running` (no terminal
  // `run-finished`) and the loop stops here, propagating `awaiting` up. A Complete replay re-enters
  // this iteration container and drives it forward.
  if (outcome.status === "awaiting") return outcome;
  // The load placement rule refuses a goto under `while-do` (spec docs/spec/goto.md §2.2), so a jump
  // never reaches an iteration container.
  if (outcome.status === "goto") throw new Error(`while-do "${node.name}": a goto jumped out of its body`);
  await containerEmitter.runFinished(outcome);
  return outcome;
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
  const maxIterations = resolveBound(run, node, exec);
  if (typeof maxIterations !== "number") return maxIterations;

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
    // Each iteration is its own run scope (ADR 0037): a container run under this one, with the body
    // dispatched inside it so its runs get a unique parent and a completed loop reuses across Resume.
    const bodyOutcome = await runLoopIteration(run, node, iterations, iterationOutput, exec);
    if (bodyOutcome.status !== "succeeded") return bodyOutcome;
    iterationOutput = bodyOutcome.output;
  }
}

/**
 * A loop bound — `while-do`'s `max_iterations` or a goto's `max_jumps` — as a positive integer: taken
 * as written, or interpolated over `config` + `context` now. A failed outcome when it resolves to no
 * positive integer.
 */
function resolveBound(
  run: RunContext,
  node: WhileDoNode | GotoNode,
  exec: NodeExecContext,
): number | Extract<SeqOutcome, { status: "failed" }> {
  const [field, value] = node.type === "goto" ? ["max_jumps", node.max_jumps] : ["max_iterations", node.max_iterations];
  if (typeof value === "number") return value;
  const scope: InterpolationScope = { config: configScope(run.fileConfig), context: exec.context };
  let resolved: string;
  try {
    resolved = interpolateToString(value, scope);
  } catch (err) {
    return { status: "failed", error: describeInterpolationError(node.name, err) };
  }
  const parsed = Number(resolved);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { status: "failed", error: `${node.type} "${node.name}": ${field} resolved to "${resolved}", which is not a positive integer` };
  }
  return parsed;
}

/**
 * A goto node (ADR 0053, spec docs/spec/goto.md §3.2): no run of its own, only a jump. It names its
 * target first-level node by GUID and passes its incoming output through unchanged, for the target to
 * read (§4). The file's top-level walk consumes the jump; every walker in between hands it up.
 */
function runGotoNode(run: RunContext, node: GotoNode, incomingOutput: JsonValue): SeqOutcome {
  const target = run.file.body.find((candidate) => candidate.name === node.target);
  // The load check (`@path/schema` goto rules) refuses a file whose target is not a first-level node,
  // so a miss is a caller that skipped the load.
  if (!target) return { status: "failed", error: `goto target "${node.target}" not found in this file` };
  return { status: "goto", goto: node.id, target: target.id, output: incomingOutput };
}

/**
 * The resume state for pass `pass` of a resuming workflow-run (ADR 0054 §5–6, spec docs/spec/goto.md
 * §8.1). While the walk is still `paired`, the pass pairs with the predecessor's pass holding the same
 * ordinal **and** opened by the same goto (`null` for pass 1), whatever that pass's status, and its
 * `planReuse` is scoped to that pass: a failed pass reuses its succeeded nodes and re-runs from the
 * failure. No such pass (or an earlier mismatch) runs fresh: no counterpart, an empty plan.
 *
 * Resume-from-K at this level names the pass N its boundary B sits in. Passes before N pair as plain
 * Resume; pass N pairs with this level's boundary applied inside it (B and after re-run, B descended
 * when a deeper K follows); every pass after N runs fresh, paired or not.
 */
function passResumeState(resume: RunResume, file: WorkflowFile, pass: number, opener: GotoNode | null, paired: boolean): RunResume {
  const fresh: RunResume = { input: resume.input, counterpart: undefined, plan: new Map(), rerunSuffix: [], rerunPasses: [] };
  let boundaryPass: number | undefined;
  if (resume.rerunSuffix.length > 0) {
    // A boundary with no pass means the predecessor ran this level with no passes (a goto added
    // since), or a caller that named none. Either way no pass is known to hold B, so nothing pairs:
    // pairing without the boundary would silently reuse the work the operator asked to drop.
    const named = resume.rerunPasses[0];
    if (typeof named !== "number") return fresh;
    boundaryPass = named;
  }
  if (!paired || (boundaryPass !== undefined && pass > boundaryPass)) return fresh;
  const counterpart = resume.input.originalRuns.find(
    (r) => r.parentRunId === resume.counterpart?.runId && r.pass === pass && r.nodeId === (opener?.id ?? null),
  );
  if (!counterpart) return fresh;
  const atBoundary = pass === boundaryPass;
  const rerunSuffix = atBoundary ? resume.rerunSuffix : [];
  return {
    input: resume.input,
    counterpart,
    plan: planReuse(resume.input.originalRuns, file, counterpart.runId, buildSuppressSet(file, rerunSuffix)),
    rerunSuffix,
    rerunPasses: atBoundary ? resume.rerunPasses : [],
  };
}

/**
 * One workflow-run's **top-level walk** (ADR 0053/0054, spec docs/spec/goto.md §3): its file's first
 * level walked as an index loop with a jump register, so a goto can re-seek it. A goto-free file has no passes and is
 * walked by `runSequence` exactly as before. A file holding a goto walks in **passes**: each forward
 * stretch — from the start, or from a jump target, to the next jump taken or the end of the body — is a
 * container run under this workflow-run, and every run made in it is the pass's child. The pass shares
 * this run's context (`exec` threads through unchanged), so context is one last-writer-wins blackboard
 * across passes (ADR 0059).
 *
 * A jump is counted per goto for this walk; the jump after the last one `max_jumps` allows fails the
 * pass and, with it, the workflow-run. The target's incoming output is the goto's passed-through
 * output, forward or backward (ADR 0055).
 */
async function runTopLevelWalk(run: RunContext, seedInput: JsonValue, exec: NodeExecContext): Promise<SeqOutcome> {
  const body = run.file.body;
  const gotos = new Map<string, GotoNode>();
  for (const node of walkNodes(body)) if (node.type === "goto") gotos.set(node.id, node);
  if (gotos.size === 0) return runSequence(run, body, seedInput, exec);
  const indexById = new Map(body.map((node, index) => [node.id, index]));

  const jumpsSpent = new Map<string, number>();
  let pass = 1;
  let opener: GotoNode | null = null;
  let start = 0;
  let carried = seedInput;
  // Resume pairing (spec §8.1): true while every pass so far found its predecessor counterpart. The
  // first mismatch leaves the record, so that pass and every later one run fresh.
  let paired = true;
  // Complete (ADR 0060, spec §8.2): follow the record. Every recorded pass counts one jump for the goto
  // that opened it, and the walk re-enters the one `running` pass in place. Closed passes are facts,
  // not re-walked: no condition, goto or event of theirs is replayed.
  let reentered: RunRecord | undefined;
  if (run.continue) {
    const passes = recordedPasses(run.continue, run.identity.runId);
    for (const recorded of passes) {
      if (recorded.nodeId !== null) jumpsSpent.set(recorded.nodeId, (jumpsSpent.get(recorded.nodeId) ?? 0) + 1);
    }
    reentered = passes.find((recorded) => recorded.status === "running");
  }
  if (reentered && run.continue) {
    pass = reentered.pass!;
    carried = run.continue.readBlob(reentered, RUN_BLOB_FILE.input);
    if (pass > 1) {
      // Pass N starts at its opening goto's target in the reloaded file, which must be the node the
      // pass recorded first; else the tail would no longer match the pass's rows.
      const goto = reentered.nodeId === null ? undefined : gotos.get(reentered.nodeId);
      const target = goto && body.find((candidate) => candidate.name === goto.target);
      // A `sequence` records no row of its own, so a sequence target's first recorded node is its first leaf.
      let firstNode: WorkflowNode | undefined = target;
      while (firstNode?.type === "sequence" && firstNode.body.length > 0) firstNode = firstNode.body[0];
      const recordedFirst = firstRecordedChild(run.continue, reentered.runId);
      if (!target || firstNode!.id !== recordedFirst?.nodeId) {
        const error =
          `Complete replay diverged: pass ${pass} was opened by goto "${goto?.name ?? reentered.nodeName}" ` +
          `whose target is now "${goto?.target ?? "(none)"}", recorded "${recordedFirst?.nodeName ?? "(none)"}"`;
        return failDivergedPass(run, reentered, error);
      }
      opener = goto!;
      start = indexById.get(target.id)!;
    }
  }
  for (;;) {
    const passIdentity: RunIdentity = {
      runId: reentered?.runId ?? randomUUID(),
      rootRunId: run.identity.rootRunId,
      parentRunId: run.identity.runId,
      nodeId: opener?.id ?? null,
      nodeName: opener?.name ?? null,
      pass,
    };
    const passEmitter = run.emitter.child(passIdentity);
    // A re-entered running pass already has its row and was opened before; only a new pass starts.
    if (reentered === undefined) {
      // A pass's input is its seed: the walk's seed for pass 1, the opening goto's passed-through output after.
      await passEmitter.runStarted({ input: carried });
      await run.emitter.passStarted(opener, { pass });
    }
    reentered = undefined;
    const passResume = run.resume && passResumeState(run.resume, run.file, pass, opener, paired);
    if (passResume && !passResume.counterpart) paired = false;
    const passRun: RunContext = { ...run, identity: passIdentity, emitter: passEmitter, resume: passResume };

    const outcome = await runSequence(passRun, body.slice(start), carried, exec);
    // A parked leaf keeps its pass `running`, like the workflow-run around it (ADR 0041).
    if (outcome.status === "awaiting") return outcome;
    if (outcome.status !== "goto") {
      await passEmitter.runFinished(outcome);
      return outcome;
    }

    const goto = gotos.get(outcome.goto)!;
    const maxJumps = resolveBound(run, goto, exec);
    if (typeof maxJumps !== "number") {
      await passEmitter.runFinished(maxJumps);
      return maxJumps;
    }
    // `runGotoNode` names a first-level node of this same file, so the target is always indexed.
    const targetIndex = indexById.get(outcome.target)!;
    const target = body[targetIndex]!;
    const spent = jumpsSpent.get(goto.id) ?? 0;
    // Cause first (ADR 0061 §5): the goto event, then the closing pass's step-finished.
    if (spent >= maxJumps) {
      await run.emitter.gotoExhausted(goto, { target, maxJumps, pass });
      const exhausted: SeqOutcome = { status: "failed", error: `goto "${goto.name}": max_jumps (${maxJumps}) exhausted` };
      await passEmitter.runFinished(exhausted);
      return exhausted;
    }
    jumpsSpent.set(goto.id, spent + 1);
    await run.emitter.gotoTaken(goto, { target, jump: spent + 1, maxJumps, pass: pass + 1 });
    await passEmitter.runFinished({ status: "succeeded", output: outcome.output });

    pass += 1;
    opener = goto;
    start = targetIndex;
    carried = outcome.output;
  }
}

/**
 * A Complete whose running pass no longer matches the reloaded file (ADR 0060 §2): the pass and, with
 * it, the workflow-run fail. The parked leaf, when it sits in this pass, is committed first with the
 * supplied output, so a later Resume reuses it instead of asking for it again.
 */
async function failDivergedPass(run: RunContext, passRow: RunRecord, error: string): Promise<SeqOutcome> {
  const state = run.continue!;
  if (targetLeafUnder(state, passRow.runId)) {
    const leaf = state.existingRuns.find((r) => r.runId === state.target.stepRunId)!;
    await run.emitter.step({ id: leaf.nodeId!, name: leaf.nodeName! }, leaf.runId).finished({ status: "succeeded", output: state.target.output });
  }
  const failed: SeqOutcome = { status: "failed", error };
  const passIdentity: RunIdentity = {
    runId: passRow.runId,
    rootRunId: run.identity.rootRunId,
    parentRunId: run.identity.runId,
    nodeId: passRow.nodeId,
    nodeName: passRow.nodeName,
    pass: passRow.pass!,
  };
  await run.emitter.child(passIdentity).runFinished(failed);
  return failed;
}

/**
 * Runs **one node** of a workflow body, whatever kind it is: resolves its effective config and its
 * input, executes it, and lands its `publish`. `incomingOutput` is what the default-input chain
 * offers it — its predecessor's output (format doc §6.1).
 *
 * This is the engine's node seam, and there is one of it. Eight kinds sit behind it — three step
 * types executed on a worker, five engine-evaluated controllers, `checkpoint` included (CONTEXT invariant 1)
 * — and a caller, or a test, needs to know none of that. Which of the eight a node is, what config
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
    // other controllers.
    if (node.type === "sequence") return runSequence(run, node.body, incomingOutput, exec);
    if (node.type === "goto") return runGotoNode(run, node, incomingOutput);
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
  // two points effective config is materialized, and so the second that resolves `$env` and unwraps
  // `$secret` (#116, ADR 0022 sub-4) — the same call the run-start gate validated against.
  const stepConfig = resolveEffectiveConfig(mergeConfig(run.fileConfig, node.config), run.env);

  // Which of the four dispositions this node takes — reuse (Resume), reuse-this-tree's-output /
  // re-enter / park (Complete), or run fresh — is the continuation adapter's one answer, so this
  // walker, `runWorkflowNode` and `runLoopIteration` cannot disagree about what a recorded row means.
  //
  // Resume reuse (#172): a node whose recorded run this successor tree reuses does not execute at
  // all — its output is the original run's recorded `output.json`, read once from the read-only
  // original tree, and a `reuse-marker` is its whole trace (no step-started/step-finished, no run
  // row). A reused `workflow` node collapses its whole subtree here: the plan holds only that node,
  // and returning without `runWorkflowNode` means nothing inside it is ever walked — so the marker
  // fires once per reuse decision, never once per descendant. Everything downstream treats the
  // reused output identically to a freshly produced one, so the `publish` block below is shared.
  const disposition = continuationOf(run).disposition(node);
  let outcome: SeqOutcome;
  // A leaf runner reports its minted step emitter here (via `onLeafStep`), so the post-publish
  // context snapshot below is attributed to the step's own run id. A reused node and a nested
  // `workflow` node leave this undefined — the former emits no step run, the latter keeps its own
  // context.json — so neither gets a per-step snapshot here.
  let leafStep: StepEmitter | undefined;
  const continuing = run.continue;
  if (continuing && disposition.kind === "succeeded") {
    // A node already `succeeded` in this tree is reused **read-only from its own row** — no reuse
    // marker and no new row, because unlike Resume this is not a fresh successor tree. Its recorded
    // output threads down the default-input chain, and a `succeeded` `workflow` node collapses its
    // whole subtree here exactly as Resume's reuse does (we never descend into it).
    outcome = { status: "succeeded", output: readExistingOutput(continuing, disposition.existing) };
  } else if (continuing && disposition.kind === "complete") {
    // The parked leaf being Completed: transition it `awaiting → succeeded` **in place** (the narrow
    // read-only exception) by re-entering its own step-run id and finishing it with the supplied
    // output. `finishSucceeded` emits the `step-finished` that the persisted observer turns into the
    // leaf's status flip and output blob, and streams it to any watcher — then `parse: "json"` and
    // the node's `publish` land just as they would for a freshly produced leaf output.
    const step = run.emitter.step(node, disposition.existing.runId);
    leafStep = step;
    outcome = await finishSucceeded(step, node, continuing.target.output);
  } else if (disposition.kind === "park") {
    // A still-parked sibling (park-at-join): the walk parks again here, re-driving nothing. This
    // leaf is resolved by its own later Complete, and only the last such Complete runs the tail.
    return { status: "awaiting" };
  } else if (run.resume && disposition.kind === "reuse") {
    const output = run.resume.input.readBlob(disposition.original, RUN_BLOB_FILE.output);
    await run.emitter.reuseMarker(node, { originalRunId: disposition.original.runId });
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
      // A `reenter` disposition (ADR 0041) hands the child its own existing row, so the nested run is
      // re-driven in place under the same run id instead of mints a second one.
      outcome = await runWorkflowNode(node, stepInput, step, disposition.kind === "reenter" ? disposition.existing : undefined);
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
 * branch arm and each loop iteration — every block is transparent to one uniform chain (§5.4) — and
 * it is the **run's walk**, handed to every construct through `NodeExecContext.walk` rather than
 * imported by one (which is what makes it the single owner of how a body is walked).
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
