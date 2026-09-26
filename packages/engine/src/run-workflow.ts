import { randomUUID } from "node:crypto";
import {
  type ConfigObject,
  type ControllerType,
  findRootRun,
  isPlainObject,
  isStepType,
  type JsonValue,
  type LaunchFacts,
  type RerunFromNodePathEntry,
  type RunRecord,
  type WorkflowFile,
} from "@path/schema";
import { rootCancellation } from "./cancellation.js";
import { childIdentity } from "./child-run.js";
import { continuationOf, resolveRerunFromNodePath } from "./continuation.js";
import { runBranchNode, runCheckpointNode, runGotoNode, runWhileDoNode } from "./controllers.js";
import { runTopLevelWalk } from "./goto-pass.js";
import {
  describeInterpolationError,
  InterpolationError,
  interpolateValue,
  interpolationScope,
} from "./interpolate.js";
import { buildLaunchFacts } from "./launch-facts.js";
import { finishSucceeded, type LeafStepNode, runLeafStep, type StepContext } from "./leaf-step.js";
import { RUN_BLOB_FILE } from "./persistence/paths.js";
import type { LoadedStepPluginRegistry } from "./plugin/scan.js";
import type { WorkerDescriptor } from "./plugin/seam.js";
import { createProcessorSemaphore, DEFAULT_PROCESSOR_CONCURRENCY } from "./processor-semaphore.js";
import { resolveChildRef } from "./ref-tree.js";
import { type EnvSource, effectiveConfig } from "./resolve-env.js";
import {
  enterNested,
  type ResumeEntry,
  resolveResume,
  resumeSeed,
  rootResumeEntry,
} from "./resume-plan.js";
import type {
  Cancellation,
  ContinueState,
  Emit,
  NodeExecContext,
  RunContext,
  RunIdentity,
  RunResume,
  SeqOutcome,
  StepRuntime,
} from "./run-context.js";
import { createEmitter, type Emitter, type StepEmitter } from "./run-emitter.js";
import { ObserverError, type RunObserver } from "./run-observer.js";
import { runParallelNode, settleDetached } from "./run-parallel.js";
import { analyzeRunStart, resolveExecutorRegistry } from "./run-start.js";
import { maskObservation } from "./secret-mask.js";

/**
 * **The Run executor.** `runWorkflow` runs a top-level workflow as the root of a run tree; below it,
 * one workflow-run per file (`executeWorkflowRun`), one node at a time (`runNode`), in order
 * (`runSequence`). What each kind of node does lives beside this module:
 *
 * - `run-start.ts` — the registry and the run-start config read, settled before the first node;
 * - `leaf-step.ts` — a leaf step on its Worker;
 * - `controllers.ts` / `run-parallel.ts` — the engine-evaluated control constructs;
 * - `goto-pass.ts` — the file's top-level walk and its goto passes;
 * - `child-run.ts` — the id / start / finish rule every run opened under another one shares;
 * - `continuation.ts` / `resume-plan.ts` — what a recorded row means under Resume and Complete.
 */

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
  // Resume this workflow-run against the original tree (#172): the whole-tree read inputs, this run's
  // own original counterpart, and the remaining rerun path from this level down (`resume-plan.ts`).
  // Absent for a fresh run.
  resume?: ResumeEntry;
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
  // Complete-continue (ADR 0041): a re-entered run of the tree being Completed (`continue.existing`
  // defined) restores its context from its **own** `context.json` in this same tree — the blackboard
  // as it stood when the run parked. Complete has no rerun boundary, so the parked blackboard is
  // already the exact state to continue from — it keeps restore-by-load where Resume replays.
  const continueReenter = params.continue?.existing;
  const seed = resumeSeed(params.resume, identity.parentRunId === null) ?? input;
  const parkedContext =
    params.continue && continueReenter
      ? (params.continue.state.readBlob(continueReenter, RUN_BLOB_FILE.context) as {
          [key: string]: JsonValue;
        })
      : undefined;
  const context: { [key: string]: JsonValue } = { ...(parkedContext ?? seed) }; // format doc §6.3
  // The reuse plan is this run's own, scoped to its counterpart's children, with this level's
  // Resume-from-K boundary suppressed out of it (Producer A, ADR 0036).
  const resume: RunResume | undefined = params.resume
    ? resolveResume(params.resume, file)
    : undefined;
  let previousOutput: JsonValue = seed;

  // At the file boundary the incoming (operator or parent-effective) config shadows this file's
  // declared defaults key by key, nearest wins (format doc §8). One of the two points a run
  // materializes effective config, so one of the two that resolve `$env` and unwrap `$secret`
  // (#116, ADR 0022 sub-4) — what survives the merge is what every reader downstream sees: the
  // run-start gate, interpolation, conditions and the worker, with no wrapper left in it.
  // Idempotent, so the already-effective incoming half is untouched.
  const fileConfig = effectiveConfig(file.config ?? {}, incomingConfig, params.env);
  const run: RunContext = {
    file,
    fileDir,
    fileConfig,
    identity,
    emitter,
    files,
    env: params.env,
    runtime: params.runtime,
    resume,
    continue: params.continue?.state,
    detached: [],
  };
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
      const workflowOutput = interpolateValue(
        file.output as JsonValue,
        interpolationScope(fileConfig, context),
      );
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
  // The interpolated `input` must be a JSON object so its top-level keys can seed the child's context
  // (format doc §6.3). A bare `"${context.x}"` that resolves to a string/number/array can't.
  if (!isPlainObject(stepInput)) {
    return {
      status: "failed",
      error: `workflow step "${node.name}": input must be a JSON object to seed the child's context (format doc §6.3)`,
    };
  }
  if (!ctx.run.files) {
    return {
      status: "failed",
      error: `workflow step "${node.name}": no loaded file tree to resolve ref "${node.ref}"`,
    };
  }
  const child = resolveChildRef(ctx.run.fileDir, node.ref, ctx.run.files);
  if (!child) {
    return {
      status: "failed",
      error: `workflow step "${node.name}": referenced file "${node.ref}" is not in the loaded tree`,
    };
  }

  // A nested run still `running` in the tree being Completed is re-entered **in place** (ADR 0041) —
  // same run id, no `run-started` — so its parked descendants resolve under the identity they already
  // have. `runNode` passed that row in from the continuation adapter; a node with none is a fresh
  // forward run appended past the parked leaf, minting an id like any launch run.
  const identity = childIdentity(ctx.run.identity, { owner: node }, existingRun?.runId);
  const childResult = await executeWorkflowRun({
    file: child.file,
    fileDir: child.dir,
    input: stepInput,
    incomingConfig: ctx.stepConfig, // parent's effective config crosses the file boundary (§8)
    identity,
    files: ctx.run.files,
    // The child run's own emitter over the tree's one masking sink — the raw emit never crosses.
    emitter: ctx.run.emitter.child(identity),
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
    resume: enterNested(ctx.run.resume, ctx.run.file, node.id),
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
  const registry = await resolveExecutorRegistry(
    options.registry,
    options.workerOverrides,
    options.stepPluginsDir,
  );

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
    {
      input: options.operatorInput,
      config: options.operatorConfig,
      workerDefaults: options.launchWorkerDefaults,
    },
    env,
    options.inheritedLaunchSecretKeys ?? [],
  );

  const { observer } = options;

  // The original tree's own root run (`parentRunId === null`): the predecessor of this fresh root run,
  // the successor identity fact stamped on its `run-started` (#173).
  const originalRoot = findRootRun(options.resume?.originalRuns ?? []);
  const emit: Emit = observer
    ? async (o) => {
        await observer.observe(masker.isEmpty ? o : maskObservation(masker, o));
      }
    : async () => {};

  // The tree's one masking sink becomes the root run's emitter here; every descendant run gets its
  // own via `emitter.child`, so `emit` itself never travels past this call.
  const rootIdentity: RunIdentity = {
    runId,
    rootRunId: runId,
    parentRunId: null,
    nodeId: null,
    nodeName: null,
  };
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
        semaphore: createProcessorSemaphore(
          options.processorConcurrency ?? DEFAULT_PROCESSOR_CONCURRENCY,
        ),
        // The operator's run-wide launch worker-default table (ADR 0044), shared by the whole tree so a
        // nested `workflow`-ref run — which keeps `runtime` but swaps `file` — reads the same table.
        launchWorkerDefaults: options.launchWorkerDefaults,
      },
      // Resume (#172): the root run's original counterpart is the original tree's own root run.
      // From there `executeWorkflowRun` plans reuse and restores context, recursing into every
      // non-succeeded nested workflow-run. `rerunSuffix` seeds the whole Resume-from-K descent path
      // (ADR 0036) at the root; each level slices its own head off before handing the tail down, and
      // an empty path is plain Resume. `Project.resume` validated it against this file already.
      resume: options.resume ? rootResumeEntry(options.resume) : undefined,
      // Complete-continue (ADR 0041): the root run is re-entered in place — its own row is the
      // `existing` one, so `executeWorkflowRun` skips its `run-started` and restores its context from
      // this same tree. The walk then reuses succeeded rows, resolves the parked leaf, and appends
      // forward. Mutually exclusive with `resume`.
      continue: options.continue
        ? {
            state: {
              existingRuns: options.continue.existingRuns,
              readBlob: options.continue.readBlob,
              target: options.continue.target,
            },
            existing: findRootRun(options.continue.existingRuns),
          }
        : undefined,
      // The rerun boundary (K) descent path, denormalized to `{nodeId, nodeName}[]` for the root row
      // (#444, ADR 0032). Undefined on plain Resume, which leaves `rerun_from_node_path` null.
      rerunFromNodePath: options.resume
        ? resolveRerunFromNodePath(
            file,
            fileDir,
            options.files,
            options.resume.rerunFromNodePath,
            options.resume.rerunFromPasses,
          )
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
 * Runs **one node** of a workflow body, whatever kind it is: resolves its effective config and its
 * input, executes it, and lands its `publish`. `incomingOutput` is what the default-input chain
 * offers it — its predecessor's output (format doc §6.1).
 *
 * This is the engine's node seam, and there is one of it. Every kind sits behind it — a leaf step on
 * its Worker, a `workflow` step's nested run, and the six engine-evaluated controllers (CONTEXT
 * invariant 1) — and a caller, or a test, needs to know none of that. Which kind a node is, what
 * config it inherits, whether its output publishes: all of that is on this side of the seam.
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
  const stepConfig = effectiveConfig(run.fileConfig, node.config, run.env);

  // What this node's recorded row means — reuse, complete in place, park, re-enter, or run fresh — is
  // the continuation adapter's one answer, so this walker, `runWorkflowNode` and `runLoopIteration`
  // cannot disagree about it, and none of them needs to know whether this is a Resume or a Complete.
  const disposition = continuationOf(run).disposition(node);
  let outcome: SeqOutcome;
  // A leaf runner reports its minted step emitter here (via `onLeafStep`), so the post-publish
  // context snapshot below is attributed to the step's own run id. A reused node and a nested
  // `workflow` node leave this undefined — the former emits no step run, the latter keeps its own
  // context.json — so neither gets a per-step snapshot here.
  let leafStep: StepEmitter | undefined;
  if (disposition.kind === "reuse") {
    // The node does not execute: its recorded output threads down the default-input chain like a
    // fresh one, and the `publish` below lands the same way. A reused `workflow` node collapses its
    // whole subtree here — nothing inside it is walked. Resume leaves one `reuse-marker` as the
    // node's whole trace (#172); Complete reads its own tree's row and marks nothing (ADR 0041).
    const output = disposition.output();
    if (disposition.reusedFrom !== undefined)
      await run.emitter.reuseMarker(node, { originalRunId: disposition.reusedFrom });
    outcome = { status: "succeeded", output };
  } else if (disposition.kind === "complete") {
    // The parked leaf being Completed transitions `awaiting → succeeded` in place, under its own
    // step-run id. `finishSucceeded` emits the `step-finished` the persisted observer turns into the
    // status flip and the output blob; `parse: "json"` and `publish` land as for a fresh output.
    const step = run.emitter.step(node, disposition.runId);
    leafStep = step;
    outcome = await finishSucceeded(step, node, disposition.output);
  } else if (disposition.kind === "park") {
    // A still-parked sibling (park-at-join): the walk parks again here, re-driving nothing. This
    // leaf is resolved by its own later Complete, and only the last such Complete runs the tail.
    return { status: "awaiting" };
  } else {
    const scope = interpolationScope(stepConfig, exec.context);
    let stepInput: JsonValue;
    try {
      stepInput = node.input !== undefined ? interpolateValue(node.input, scope) : incomingOutput;
    } catch (err) {
      return { status: "failed", error: describeInterpolationError(node.name, err) };
    }

    // One context for every step kind, derived rather than hand-built. A `workflow` step runs a nested
    // workflow-run; every other (leaf) type dispatches through the registry — one lookup, no built-in
    // branch (ADR 0021 sub-8).
    const step: StepContext = {
      run,
      exec,
      stepConfig,
      onLeafStep: (emitted) => (leafStep = emitted),
    };
    if (node.type === "workflow") {
      // A `reenter` disposition (ADR 0041) hands the child its own existing row, so the nested run is
      // re-driven in place under the same run id instead of mints a second one.
      outcome = await runWorkflowNode(
        node,
        stepInput,
        step,
        disposition.kind === "reenter" ? disposition.existing : undefined,
      );
    } else {
      outcome = await runLeafStep(node as unknown as LeafStepNode, stepInput, step);
    }
  }
  if (outcome.status !== "succeeded") return outcome;

  if (node.publish) {
    const publishScope = interpolationScope(stepConfig, exec.context, outcome.output);
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
