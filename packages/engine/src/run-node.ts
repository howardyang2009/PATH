import {
  type ConfigObject,
  type ControllerType,
  isPlainObject,
  isStepType,
  type JsonValue,
  type LaunchFacts,
  type RerunFromNodePathEntry,
  type RunRecord,
  type WorkflowFile,
} from "@path/schema";
import { childIdentity } from "./child-run.js";
import type { Continuation } from "./continuation.js";
import { runBranchNode, runCheckpointNode, runGotoNode, runWhileDoNode } from "./controllers.js";
import { runTopLevelWalk } from "./goto-pass.js";
import {
  describeInterpolationError,
  InterpolationError,
  interpolateValue,
  interpolationScope,
} from "./interpolate.js";
import { finishSucceeded, type LeafStepNode, runLeafStep, type StepContext } from "./leaf-step.js";
import { resolveChildRef } from "./ref-tree.js";
import { type EnvSource, effectiveConfig } from "./resolve-env.js";
import type {
  Cancellation,
  NodeExecContext,
  RunContext,
  RunIdentity,
  SeqOutcome,
  StepRuntime,
} from "./run-context.js";
import type { Emitter, StepEmitter } from "./run-emitter.js";
import { ObserverError } from "./run-observer.js";
import type { RunResult } from "./run-options.js";
import { runParallelNode, settleDetached } from "./run-parallel.js";

/** The recursive walk: a workflow-run walks its body node by node, and a `workflow` node runs a
 * nested workflow-run. */

// Everything a workflow-run needs for one file; incoming config crosses file boundaries, context
// does not (§8).
export interface WorkflowRunParams {
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
   * The tree's cancellation chain: a nested run inherits its block's authority, so its leaves die
   * with a sibling (mvp spec §5.6).
   */
  signal?: AbortSignal;
  cancellation?: Cancellation;
  /**
   * What is already recorded under this run (Resume or Complete); a fresh launch passes
   * `noContinuation()`.
   */
  continuation: Continuation;
  rerunFromNodePath?: RerunFromNodePathEntry[];
  resumedFromRootRunId?: string;
  sourceWorkflowPath?: string;
}

/** Executes one workflow-run: walks the file's body sequentially (mvp spec §5.1) — leaf steps on
 * their workers, `workflow` steps as nested runs, controls evaluated in the same walk. */
export async function executeWorkflowRun(params: WorkflowRunParams): Promise<RunResult> {
  const { file, fileDir, input, incomingConfig, identity, files, emitter, continuation } = params;

  // Resume replays from the run's **seed**, never the counterpart's final `context.json` — under
  // Resume-from-K that holds keys written after K. Complete re-entry restores its parked blackboard
  // (ADR 0062).
  const start = continuation.start();
  const reentry = start?.kind === "reentry" ? start : undefined;
  const seed = start?.kind === "seed" ? (start.seed ?? input) : input;
  const context: { [key: string]: JsonValue } = { ...(reentry?.context ?? seed) }; // format doc §6.3
  let previousOutput: JsonValue = seed;

  // Incoming config shadows this file's defaults key by key (format doc §8); the second point
  // `$env`/`$secret` resolve (ADR 0022 sub-4).
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
    continuation,
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
  // A run whose leaf step was killed by a failing sibling or an operator abort ends `cancelled`
  // (mvp spec §5.6).
  const cancel = async (): Promise<RunResult> => {
    await emitter.runFinished({ status: "cancelled" });
    return { status: "cancelled", output: previousOutput };
  };

  // A log-backend write failure fails the run audit-first (mvp spec §8.2); any other thrown error
  // is a bug and propagates. Each run converts its own hooks' ObserverError, so a nested failure
  // travels up.
  const failFromObserverError = async (err: ObserverError): Promise<RunResult> => {
    // Honour the exit barrier even on an audit fault: no detached branch may outlive its owning run
    // (§1.1).
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
    // `context.json`, so it skips its start — a second one would duplicate the row.
    if (reentry === undefined) {
      await emitter.runStarted({
        // The seed, not raw `input`: recording it lets a Resume of this successor replay from it.
        input: seed,
        resumedFromRootRunId: params.resumedFromRootRunId,
        rerunFromNodePath: params.rerunFromNodePath,
        // Root-only (ADR 0046): recorded so a later resume/Complete recovers the config and worker
        // table.
        launchFacts: params.launchFacts,
        workflowId: file.id,
        workflowName: file.name,
        workflowPath: params.sourceWorkflowPath,
      });
    }

    // A run-start config failure lands here, not at load: the run exists, is recorded, and ends
    // `failed` before its first node — operator config has no load to fail at. An abort in flight
    // wins (§5.6).
    if (params.runStartFailure !== undefined && params.signal?.aborted !== true) {
      return fail(params.runStartFailure);
    }

    const outcome = await runTopLevelWalk(run, input, {
      context,
      signal: params.signal,
      cancellation: params.cancellation,
      onPublish: async () => {
        await emitter.record({ kind: "context", context });
      },
      walk: runSequence,
    });
    // The run parked at a person-activity leaf (ADR 0039/0041): no terminal `step-finished`, the
    // row stays `running`, and its detached branches keep running until a later Complete settles
    // it.
    if (outcome.status === "awaiting") return { status: "awaiting", output: previousOutput };
    // Drain every detached branch before this run reports finished, so the tree stays strictly
    // nested (§1.1/§2).
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

// A `workflow` step: resolve `ref` against the loaded tree and run the child as a nested run.
// Context is isolated (fresh seed), the parent's effective config crosses (§8), its output map is
// this step's.
async function runWorkflowNode(
  node: Extract<WorkflowFile["body"][number], { type: "workflow" }>,
  stepInput: JsonValue,
  ctx: StepContext,
  /** The existing row this nested run re-enters in place on a Complete replay (ADR 0041); undefined
   * on a fresh run. */
  existingRun?: RunRecord,
): Promise<SeqOutcome> {
  // The interpolated `input` must be a JSON object so its keys can seed the child's context (format
  // doc §6.3).
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

  // A still-`running` nested run in the tree being Completed is re-entered in place (ADR 0041):
  // same id.
  const identity = childIdentity(ctx.run.identity, { owner: node }, existingRun?.runId);
  const childResult = await executeWorkflowRun({
    file: child.file,
    fileDir: child.dir,
    input: stepInput,
    incomingConfig: ctx.stepConfig,
    identity,
    files: ctx.run.files,
    emitter: ctx.run.emitter.child(identity),
    // The root's snapshot, so every file resolves `$env` against one environment; the root owns the
    // unset check.
    env: ctx.run.env,
    runtime: ctx.run.runtime,
    signal: ctx.exec.signal,
    cancellation: ctx.exec.cancellation,
    // The parent's continuation scopes itself to this child run (Resume recurses into every
    // non-succeeded workflow-run against its own counterpart, ADR 0036; Complete re-enters the same
    // run in place, ADR 0041).
    continuation: ctx.run.continuation.enter({ owner: node }, child.file, identity),
  });

  if (childResult.status === "cancelled") return { status: "cancelled" };
  // The child parked; this step's own run *is* that child run (invariant 2), so it parks too.
  if (childResult.status === "awaiting") return { status: "awaiting" };
  if (childResult.status === "failed") {
    return { status: "failed", error: `workflow step "${node.name}": ${childResult.error}` };
  }
  return { status: "succeeded", output: childResult.output };
}

type WorkflowNode = WorkflowFile["body"][number];
type ControlNode = Extract<WorkflowNode, { type: ControllerType }>;

// The engine-evaluated controls the walker owns (CONTEXT invariant 1); derived from
// `@path/schema`'s `isStepType`.
function isControlNode(node: WorkflowNode): node is ControlNode {
  return !isStepType(node.type);
}

/** Runs **one node**, whatever kind: resolves its effective config and input, executes it, and
 * lands its `publish`. `incomingOutput` is the default-input chain's offer (format doc §6.1). */
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
    // transparent to `exec`.
    if (node.type === "sequence") return runSequence(run, node.body, incomingOutput, exec);
    if (node.type === "goto") return runGotoNode(run, node, incomingOutput);
    // Compile-time guard: a new control member breaks the build here. An unknown *leaf* type is
    // caught below, at the registry lookup.
    const unwalked: never = node;
    const unknown = unwalked as { type: string; id: string };
    return {
      status: "failed",
      error: `node type "${unknown.type}" (node "${unknown.id}") is not supported by this engine`,
    };
  }

  // The second point effective config is materialized (so the second resolving `$env`/`$secret`) —
  // the call the gate validated against.
  const stepConfig = effectiveConfig(run.fileConfig, node.config, run.env);

  // The continuation owns what a recorded row means, so every walker agrees without knowing
  // Resume from Complete.
  const disposition = run.continuation.disposition(node);
  let outcome: SeqOutcome;
  // The leaf runner reports its step emitter here, so the post-publish snapshot is attributed to
  // its own run id.
  let leafStep: StepEmitter | undefined;
  if (disposition.kind === "reuse") {
    // The node does not execute: its recorded output threads the input chain and publishes as
    // usual; a reused `workflow` node collapses its subtree.
    const output = disposition.output();
    if (disposition.reusedFrom !== undefined)
      await run.emitter.emit(node, {
        type: "reuse-marker",
        original_run_id: disposition.reusedFrom,
      });
    outcome = { status: "succeeded", output };
  } else if (disposition.kind === "settle") {
    // The parked leaf transitions `awaiting → succeeded` in place under its own step-run id;
    // publish lands as for a fresh output.
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

    // One context for every step kind; a `workflow` step runs a nested run, every other type
    // dispatches through the registry.
    const step: StepContext = {
      run,
      exec,
      stepConfig,
      onLeafStep: (emitted) => (leafStep = emitted),
    };
    if (node.type === "workflow") {
      // A re-entered row hands the child its own existing row, so it is re-driven in place
      // (ADR 0041).
      outcome = await runWorkflowNode(node, stepInput, step, disposition.existing);
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
    // Every entry resolves before any is written, so the publish lands atomically (§5.3) and only
    // on this run's context.
    Object.assign(exec.context, updates);
    await exec.onPublish(updates);
  }

  // Every executed leaf records the context as it stands now, publish included, so it is followable
  // step by step.
  if (leafStep !== undefined) {
    await leafStep.record({ kind: "context", context: exec.context });
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
    // An abort arriving between two nodes stops the walk here (mvp spec §5.6): starting a run only
    // to kill it would record a run that never really ran, and controls have no process to
    // interrupt.
    if (exec.signal?.aborted) return { status: "cancelled" };

    const outcome = await runNode(run, node, previous, exec);
    if (outcome.status !== "succeeded") return outcome;
    previous = outcome.output;
  }

  return { status: "succeeded", output: previous };
}
