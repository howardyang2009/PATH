import { type ControllerType, isStepType, type JsonValue, type WorkflowFile } from "@path/schema";
import { continuationOf } from "./continuation.js";
import { runBranchNode, runCheckpointNode, runGotoNode, runWhileDoNode } from "./controllers.js";
import { describeInterpolationError, interpolateValue, interpolationScope } from "./interpolate.js";
import { finishSucceeded, type LeafStepNode, runLeafStep, type StepContext } from "./leaf-step.js";
import { effectiveConfig } from "./resolve-env.js";
import type { NodeExecContext, RunContext, SeqOutcome } from "./run-context.js";
import type { StepEmitter } from "./run-emitter.js";
import { runParallelNode } from "./run-parallel.js";
import { runWorkflowNode } from "./run-workflow.js";

type WorkflowNode = WorkflowFile["body"][number];
type ControlNode = Extract<WorkflowNode, { type: ControllerType }>;

// The engine-evaluated controls the walker owns (CONTEXT invariant 1); derived from `@path/schema`'s `isStepType`.
function isControlNode(node: WorkflowNode): node is ControlNode {
  return !isStepType(node.type);
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
