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

/** **The Run executor**: `runWorkflow` roots a run tree — one workflow-run per file, one node at a time in order. */

/** Test/host worker overrides (ADR 0021 sub-15): `(type, worker-name)` → descriptor, merged **replace-only**. */
export type WorkerOverrides = { [type: string]: { [name: string]: WorkerDescriptor } };

export interface RunOptions {
  input?: { [key: string]: JsonValue };
  operatorConfig?: ConfigObject;
  /**
   * The operator's **override input** as supplied (ADR 0046) — the pre-fallback seed; never re-applied on a
   * continuation.
   */
  operatorInput?: JsonValue;
  /**
   * Frozen launch-config secrets the continuation did not supply again (ADR 0046); the run ends before its first step
   * naming them.
   */
  unresolvedLaunchSecrets?: string[];
  /** The `secretKeys` a continuation inherited (ADR 0046), so its own frozen copy still marks them. */
  inheritedLaunchSecretKeys?: string[];
  files?: Map<string, WorkflowFile>;
  observer?: RunObserver;
  warn?: (message: string) => void;
  /** Replace named `(type, worker)` pairs in the scanned registry before dispatch — replace-only (ADR 0021 sub-15). */
  workerOverrides?: WorkerOverrides;
  /**
   * Launch worker-default table (ADR 0044): run-wide, above `file.worker_defaults`, below an explicit `node.worker`
   * pin.
   */
  launchWorkerDefaults?: { [stepType: string]: string };
  /**
   * The frozen step-plugin registry this run dispatches against; absent means the run scans the folder (ADR 0019
   * sub-15).
   */
  registry?: LoadedStepPluginRegistry;
  /** Plugin folder for the self-scan fallback; consulted only when `registry` is absent (ADR 0019 sub-8). */
  stepPluginsDir?: string;
  /** Engine-wide Processor cap (mvp spec §5.5), default 4 — one semaphore for the whole run tree. */
  processorConcurrency?: number;
  /**
   * External abort: kills this root run's in-flight leaf steps best-effort, ending it `cancelled`; already-aborted
   * cancels at once (§5.6).
   */
  signal?: AbortSignal;
  /** Resume a prior tree: reuse every succeeded run whose node id still matches (ADR 0062). */
  resume?: ResumeInput;
  /**
   * Complete an awaiting leaf by replaying the existing tree in place (ADR 0041): same tree and ids, then append
   * forward.
   */
  continue?: ContinueInput;
  sourceWorkflowPath?: string;
}

/**
 * What a successor run needs from the original tree: its run rows plus a reader for one blob. The engine core does no
 * I/O.
 */
export interface ResumeInput {
  originalRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  /** The **rerun boundary (K)** as the descent path of node ids (ADR 0032/0036): empty/undefined is plain Resume. */
  rerunFromNodePath?: string[];
  /** Beside `rerunFromNodePath`, level for level: the goto pass K's path-node sits in, or `null` (ADR 0054 §6). */
  rerunFromPasses?: (number | null)[];
}

/**
 * What a Complete re-invocation needs (ADR 0041): the tree's rows, a blob reader, and the parked leaf to transition.
 */
export interface ContinueInput {
  rootRunId: string;
  existingRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  target: { stepRunId: string; output: JsonValue };
}

// A failed run still carries the last-succeeded node's output, so `output` is unconditional.
export interface RunResult {
  // `awaiting` is **not** terminal: the run parked at a person-activity leaf and a later Complete reopens it (ADR
  // 0039/0041).
  status: "succeeded" | "failed" | "cancelled" | "awaiting";
  /**
   * On success the workflow's `output` map (format doc §6.4; absent = `{}`), **real**, secrets included — the run's
   * product.
   */
  output: JsonValue;
  error?: string;
}

// Everything a workflow-run needs for one file; incoming config crosses file boundaries, context does not (§8).
interface WorkflowRunParams {
  file: WorkflowFile;
  fileDir: string;
  input: { [key: string]: JsonValue };
  incomingConfig: ConfigObject;
  identity: RunIdentity;
  files?: Map<string, WorkflowFile>;
  emitter: Emitter;
  /** The environment snapshot every `$env` in this run tree resolves against — taken once. */
  env: EnvSource;
  runStartFailure?: string;
  launchFacts?: LaunchFacts;
  runtime: StepRuntime;
  /**
   * The tree's cancellation chain: a nested run inherits its block's authority, so its leaves die with a sibling (mvp
   * spec §5.6).
   */
  signal?: AbortSignal;
  cancellation?: Cancellation;
  resume?: ResumeEntry;
  continue?: { state: ContinueState; existing: RunRecord | undefined };
  rerunFromNodePath?: RerunFromNodePathEntry[];
  resumedFromRootRunId?: string;
  sourceWorkflowPath?: string;
}

type WorkflowNode = WorkflowFile["body"][number];
type ControlNode = Extract<WorkflowNode, { type: ControllerType }>;

// The engine-evaluated controls the walker owns (CONTEXT invariant 1); derived from `@path/schema`'s `isStepType`.
function isControlNode(node: WorkflowNode): node is ControlNode {
  return !isStepType(node.type);
}

/** Executes one workflow-run: walks the file's body sequentially (mvp spec §5.1) — leaf steps on
 * their workers, `workflow` steps as nested runs, controls evaluated in the same walk. */
async function executeWorkflowRun(params: WorkflowRunParams): Promise<RunResult> {
  const { file, fileDir, input, incomingConfig, identity, files, emitter } = params;

  // Resume replays from the run's **seed**, never the counterpart's final `context.json` — under
  // Resume-from-K that holds keys written after K. Complete re-entry restores its parked blackboard (ADR 0062).
  const continueReenter = params.continue?.existing;
  const seed = resumeSeed(params.resume, identity.parentRunId === null) ?? input;
  const parkedContext =
    params.continue && continueReenter
      ? (params.continue.state.readBlob(continueReenter, RUN_BLOB_FILE.context) as {
          [key: string]: JsonValue;
        })
      : undefined;
  const context: { [key: string]: JsonValue } = { ...(parkedContext ?? seed) }; // format doc §6.3
  const resume: RunResume | undefined = params.resume
    ? resolveResume(params.resume, file)
    : undefined;
  let previousOutput: JsonValue = seed;

  // Incoming config shadows this file's defaults key by key (format doc §8); the second point `$env`/`$secret`
  // resolve (ADR 0022 sub-4).
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
  // A run whose leaf step was killed by a failing sibling or an operator abort ends `cancelled` (mvp spec §5.6).
  const cancel = async (): Promise<RunResult> => {
    await emitter.runFinished({ status: "cancelled" });
    return { status: "cancelled", output: previousOutput };
  };

  // A log-backend write failure fails the run audit-first (mvp spec §8.2); any other thrown error is a
  // bug and propagates. Each run converts its own hooks' ObserverError, so a nested failure travels up.
  const failFromObserverError = async (err: ObserverError): Promise<RunResult> => {
    // Honour the exit barrier even on an audit fault: no detached branch may outlive its owning run (§1.1).
    try {
      await settleDetached(run);
    } catch {
      // a detached branch's own audit write may fault too; nothing more to salvage
    }
    try {
      await emitter.runFinished({ status: "failed", error: err.message });
    } catch {
      // the audit write already failed; still report the run as failed
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
    // Source identity is root-only: the root run *is* the top-level workflow (invariant 2); the
    // emitter drops a nested run's file id. A Complete re-entry (ADR 0041) already has its row and
    // `context.json`, so it skips `run-started` — a second one would duplicate the row.
    if (continueReenter === undefined) {
      await emitter.runStarted({
        // The seed, not raw `input`: recording it lets a Resume of this successor replay from it.
        input: seed,
        resumedFromRootRunId: params.resumedFromRootRunId,
        rerunFromNodePath: params.rerunFromNodePath,
        // Root-only (ADR 0046): recorded so a later resume/Complete recovers the config and worker table.
        launchFacts: params.launchFacts,
        workflowId: file.id,
        workflowName: file.name,
        workflowPath: params.sourceWorkflowPath,
      });
    }

    // A run-start config failure lands here, not at load: the run exists, is recorded, and ends
    // `failed` before its first node — operator config has no load to fail at. An abort in flight wins (§5.6).
    if (params.runStartFailure !== undefined && params.signal?.aborted !== true) {
      return fail(params.runStartFailure);
    }

    const outcome = await runTopLevelWalk(run, input, {
      context,
      signal: params.signal,
      cancellation: params.cancellation,
      onPublish: async () => {
        await emitter.contextChanged(context);
      },
      walk: runSequence,
    });
    // The run parked at a person-activity leaf (ADR 0039/0041): no terminal `run-finished`, the row
    // stays `running`, and its detached branches keep running until a later Complete settles it.
    if (outcome.status === "awaiting") return { status: "awaiting", output: previousOutput };
    // Drain every detached branch before this run reports finished, so the tree stays strictly nested (§1.1/§2).
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

// A `workflow` step: resolve `ref` against the loaded tree and run the child as a nested run. Context
// is isolated (fresh seed), the parent's effective config crosses (§8), its output map is this step's.
async function runWorkflowNode(
  node: Extract<WorkflowFile["body"][number], { type: "workflow" }>,
  stepInput: JsonValue,
  ctx: StepContext,
  /** The existing row this nested run re-enters in place on a Complete replay (ADR 0041); undefined on a fresh run. */
  existingRun?: RunRecord,
): Promise<SeqOutcome> {
  // The interpolated `input` must be a JSON object so its keys can seed the child's context (format doc §6.3).
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

  // A still-`running` nested run in the tree being Completed is re-entered in place (ADR 0041): same id.
  const identity = childIdentity(ctx.run.identity, { owner: node }, existingRun?.runId);
  const childResult = await executeWorkflowRun({
    file: child.file,
    fileDir: child.dir,
    input: stepInput,
    incomingConfig: ctx.stepConfig,
    identity,
    files: ctx.run.files,
    emitter: ctx.run.emitter.child(identity),
    // The root's snapshot, so every file resolves `$env` against one environment; the root owns the unset check.
    env: ctx.run.env,
    runtime: ctx.run.runtime,
    signal: ctx.exec.signal,
    cancellation: ctx.exec.cancellation,
    // Continue this child in place when the tree is being Completed, else undefined.
    continue: ctx.run.continue ? { state: ctx.run.continue, existing: existingRun } : undefined,
    // Resume recurses into every non-succeeded workflow-run, each against its own counterpart (ADR 0036).
    resume: enterNested(ctx.run.resume, ctx.run.file, node.id),
  });

  if (childResult.status === "cancelled") return { status: "cancelled" };
  // The child parked; this step's own run *is* that child run (invariant 2), so it parks too.
  if (childResult.status === "awaiting") return { status: "awaiting" };
  if (childResult.status === "failed") {
    return { status: "failed", error: `workflow step "${node.name}": ${childResult.error}` };
  }
  return { status: "succeeded", output: childResult.output };
}

/** Runs the top-level workflow as the root of a run tree (mvp spec §2, invariant 2). */
export async function runWorkflow(
  file: WorkflowFile,
  fileDir: string,
  options: RunOptions = {},
): Promise<RunResult> {
  // A Complete keeps the tree's own root id; a launch or Resume mints a fresh one.
  const runId = options.continue?.rootRunId ?? randomUUID();

  // One snapshot for the whole run, read here and nowhere else, so a mid-run env change cannot desync the masker.
  const env: EnvSource = { ...process.env };

  // The load's scanned registry, or a folder scan for a caller with no load; `workerOverrides` merge replace-only.
  const registry = await resolveExecutorRegistry(
    options.registry,
    options.workerOverrides,
    options.stepPluginsDir,
  );

  // The whole run-start config read behind one seam: collect, resolve `$env`, collect `$secret`, gate (ADR 0022 sub-3).
  const { masker, runStartFailure } = analyzeRunStart(file, fileDir, options, env, registry);
  for (const warning of masker.warnings) options.warn?.(warning);

  // Assembled once from the same options the run executes with, so recorded facts and executed config cannot drift.
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

  // The original tree's root run — the predecessor fact stamped on this fresh root's `run-started`.
  const originalRoot = findRootRun(options.resume?.originalRuns ?? []);
  const emit: Emit = observer
    ? async (o) => {
        await observer.observe(masker.isEmpty ? o : maskObservation(masker, o));
      }
    : async () => {};

  // The tree's one masking sink becomes the root emitter; descendants get their own via `emitter.child`.
  const rootIdentity: RunIdentity = {
    runId,
    rootRunId: runId,
    parentRunId: null,
    nodeId: null,
    nodeName: null,
  };
  // The tree's root cancellation authority: the operator's signal is its only outside cause (`cancellation.ts`).
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
      signal: rootAuthority.signal,
      cancellation: rootAuthority,
      // One registry and one semaphore for the whole run tree — the cap is engine-wide (mvp spec §5.5).
      runtime: {
        registry,
        semaphore: createProcessorSemaphore(
          options.processorConcurrency ?? DEFAULT_PROCESSOR_CONCURRENCY,
        ),
        // The launch worker-default table is shared by the whole tree (ADR 0044).
        launchWorkerDefaults: options.launchWorkerDefaults,
      },
      // Root Resume: the counterpart is the original tree's root; an empty rerun path is plain Resume (ADR 0036).
      resume: options.resume ? rootResumeEntry(options.resume) : undefined,
      // Complete-continue: the root re-enters in place, skipping `run-started` (ADR 0041). Exclusive with `resume`.
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
      // K's descent path, denormalized for the root row; undefined on plain Resume (ADR 0032).
      rerunFromNodePath: options.resume
        ? resolveRerunFromNodePath(
            file,
            fileDir,
            options.files,
            options.resume.rerunFromNodePath,
            options.resume.rerunFromPasses,
          )
        : undefined,
      // This fresh root resumes the original tree, so its predecessor is that tree's root run id.
      resumedFromRootRunId: originalRoot?.runId,
      // Root-only provenance: the root file's store-relative path, recorded on the root row.
      sourceWorkflowPath: options.sourceWorkflowPath,
    });
  } catch (err) {
    // A worker that threw rather than returning `failed` (ADR 0020 sub-5): it is not caught into a
    // failed step, but its message may carry a config secret, so the masker scrubs it on the way out.
    if (!masker.isEmpty && err instanceof Error) {
      err.message = masker.maskString(err.message);
    }
    throw err;
  }

  // What the caller gets back is masked too — everything except a *succeeded* run's `output`, which
  // is the run's product and prints as the pipeline's answer. `error` always: it carries text the
  // engine did not compose, and the CLI prints it into a CI log. A thrown bug escapes unscrubbed (§8.3).
  if (masker.isEmpty) return result;
  return {
    ...result,
    ...(result.status === "succeeded" ? {} : { output: masker.maskValue(result.output) }),
    ...(result.error !== undefined ? { error: masker.maskString(result.error) } : {}),
  };
}

/** Runs **one node**, whatever kind: resolves its effective config and input, executes it, and lands
 * its `publish`. `incomingOutput` is the default-input chain's offer (format doc §6.1). */
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
    // A `sequence` adds no execution rule (`@2` §4.4): it runs its body as a nested node sequence, transparent to `exec`.
    if (node.type === "sequence") return runSequence(run, node.body, incomingOutput, exec);
    if (node.type === "goto") return runGotoNode(run, node, incomingOutput);
    // Compile-time guard: a new control member breaks the build here. An unknown *leaf* type is caught
    // below, at the registry lookup.
    const unwalked: never = node;
    const unknown = unwalked as { type: string; id: string };
    return {
      status: "failed",
      error: `node type "${unknown.type}" (node "${unknown.id}") is not supported by this engine`,
    };
  }

  // The second point effective config is materialized (so the second resolving `$env`/`$secret`) — the call the gate
  // validated against.
  const stepConfig = effectiveConfig(run.fileConfig, node.config, run.env);

  // The continuation adapter owns what a recorded row means, so every walker agrees without knowing Resume from
  // Complete.
  const disposition = continuationOf(run).disposition(node);
  let outcome: SeqOutcome;
  // The leaf runner reports its step emitter here, so the post-publish snapshot is attributed to its own run id.
  let leafStep: StepEmitter | undefined;
  if (disposition.kind === "reuse") {
    // The node does not execute: its recorded output threads the input chain and publishes as usual; a reused
    // `workflow` node collapses its subtree.
    const output = disposition.output();
    if (disposition.reusedFrom !== undefined)
      await run.emitter.reuseMarker(node, { originalRunId: disposition.reusedFrom });
    outcome = { status: "succeeded", output };
  } else if (disposition.kind === "complete") {
    // The parked leaf transitions `awaiting → succeeded` in place under its own step-run id; publish lands as for a
    // fresh output.
    const step = run.emitter.step(node, disposition.runId);
    leafStep = step;
    outcome = await finishSucceeded(step, node, disposition.output);
  } else if (disposition.kind === "park") {
    // A still-parked sibling: the walk parks again; only the last such Complete runs the tail.
    return { status: "awaiting" };
  } else {
    const scope = interpolationScope(stepConfig, exec.context);
    let stepInput: JsonValue;
    try {
      stepInput = node.input !== undefined ? interpolateValue(node.input, scope) : incomingOutput;
    } catch (err) {
      return { status: "failed", error: describeInterpolationError(node.name, err) };
    }

    // One context for every step kind; a `workflow` step runs a nested run, every other type dispatches through the
    // registry.
    const step: StepContext = {
      run,
      exec,
      stepConfig,
      onLeafStep: (emitted) => (leafStep = emitted),
    };
    if (node.type === "workflow") {
      // A `reenter` disposition hands the child its own existing row, so it is re-driven in place (ADR 0041).
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
    // Every entry resolves before any is written, so the publish lands atomically (§5.3) and only on this run's context.
    Object.assign(exec.context, updates);
    await exec.onPublish(updates);
  }

  // Every executed leaf records the context as it stands now, publish included, so it is followable step by step.
  if (leafStep !== undefined) {
    await leafStep.context(exec.context);
  }
  return outcome;
}

/** Walks a node sequence in order (mvp spec §5.1), threading the default-input chain and returning
 * the last output or the first non-success outcome. This one function is the run's walk. */
export async function runSequence(
  run: RunContext,
  nodes: WorkflowFile["body"],
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  let previous: JsonValue = seedInput;

  for (const node of nodes) {
    // An abort arriving between two nodes stops the walk here (mvp spec §5.6): starting a run only to
    // kill it would record a run that never really ran, and controls have no process to interrupt.
    if (exec.signal?.aborted) return { status: "cancelled" };

    const outcome = await runNode(run, node, previous, exec);
    if (outcome.status !== "succeeded") return outcome;
    previous = outcome.output;
  }

  return { status: "succeeded", output: previous };
}
