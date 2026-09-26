import type { BranchNode, CheckpointNode, GotoNode, JsonValue, WhileDoNode } from "@path/schema";
import { openContainerRun } from "./child-run.js";
import { describeConditionFailure, evaluateCondition, type Trace } from "./condition.js";
import { continuationOf } from "./continuation.js";
import {
  describeInterpolationError,
  interpolateToString,
  interpolationScope,
} from "./interpolate.js";
import { enterIteration } from "./resume-plan.js";
import type { NodeExecContext, RunContext, SeqOutcome } from "./run-context.js";

/**
 * The Structure Controllers the engine evaluates itself — `checkpoint`, `branch`, `while-do` — and the
 * Graph Controller's node, `goto`. Only a `while-do` iteration has a run of its own. Bodies walk through
 * `exec.walk`, the run's own walk handed in, never an import, so the two cannot form an import cycle.
 */

// A `checkpoint`: assert its condition over the run's `context` (or the branch's snapshot inside a
// `parallel`) + the predecessor's `output`; false or a strict error fails the run. Transparent — the
// engine keeps no run for it, so the event is attributed to this run + the node's id.
export async function runCheckpointNode(
  run: RunContext,
  node: CheckpointNode,
  incomingOutput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { outcome, trace } = evaluateCondition(node.condition, {
    context: exec.context,
    output: incomingOutput,
  });
  const passed = outcome === "true";
  await run.emitter.checkpointEvaluated(node, { passed, trace });
  if (!passed) {
    return {
      status: "failed",
      error: `checkpoint "${node.name}" failed: ${describeConditionFailure(trace)}`,
    };
  }
  return { status: "succeeded", output: incomingOutput };
}

// A `branch`: evaluate arms in declaration order, first true `when` wins, else the fallback; an
// evaluation error, or no match and no `else`, fails the run (spec §5.2). The taken arm's body runs as
// a nested sequence seeded by the predecessor's output, and its last node's output becomes the block's.
export async function runBranchNode(
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
      return {
        status: "failed",
        error: `branch "${node.name}" arm ${index}: condition evaluation error: ${describeConditionFailure(trace)}`,
      };
    }
    if (outcome === "true") {
      await run.emitter.branchTaken(node, { arm: index, trace });
      // The arm's occupant is a single node (`@2` §4.3), run as a one-node sequence.
      return exec.walk(run, [arm.node], incomingOutput, exec);
    }
  }
  if (node.else) {
    await run.emitter.branchTaken(node, { arm: "else", trace: null });
    return exec.walk(run, [node.else], incomingOutput, exec);
  }
  await run.emitter.branchNoMatch(node, { traces });
  return {
    status: "failed",
    error: `branch "${node.name}": no arm matched and there is no else (spec §5.2)`,
  };
}

/**
 * One `while-do` iteration as its own run scope, with the body dispatched inside it so its runs get a
 * unique parent and a completed loop reuses across Resume. Unlike a nested `workflow` step it does not
 * isolate context: `exec`, the loop's shared blackboard, is threaded through unchanged.
 */
async function runLoopIteration(
  run: RunContext,
  node: WhileDoNode,
  iteration: number,
  iterationInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  // Complete-continue: the adapter answers what this iteration's recorded row means — a `succeeded`
  // container is reused read-only, a `running` one is the parked iteration re-entered in place.
  const disposition = continuationOf(run).disposition(node, iteration);
  if (disposition.kind === "reuse") return { status: "succeeded", output: disposition.output() };
  // `exec` passes through unchanged, so the body publishes into the loop's own context.
  const container = await openContainerRun(run, {
    key: { owner: node, iteration },
    existingRunId: disposition.kind === "reenter" ? disposition.existing.runId : undefined,
    input: iterationInput,
    resume: enterIteration(run.resume, run.file, node.id, iteration),
  });
  // The loop body is a single node (`@2` §4.3), run as a one-node sequence inside the container.
  const outcome = await exec.walk(container.run, [node.node], iterationInput, exec);
  // The body parked at an awaiting leaf: the container stays `running` (no `run-finished`) and the loop
  // propagates `awaiting` up; a Complete replay re-enters this container and drives it on.
  if (outcome.status === "awaiting") return outcome;
  // The load placement rule refuses a goto under `while-do`, so a jump never reaches an iteration.
  if (outcome.status === "goto")
    throw new Error(`while-do "${node.name}": a goto jumped out of its body`);
  await container.finish(outcome);
  return outcome;
}

// A `while-do`: check the condition before every iteration against the run's `context` + the output
// seeding the next iteration; zero iterations exits transparently, and each body runs as a nested
// sequence seeded by the previous iteration's output. Still true after `max_iterations` fails the run.
export async function runWhileDoNode(
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
    const { outcome, trace } = evaluateCondition(node.condition, {
      context: exec.context,
      output: iterationOutput,
    });
    if (outcome === "error") {
      return {
        status: "failed",
        error: `while-do "${node.name}": condition evaluation error: ${describeConditionFailure(trace)}`,
      };
    }
    if (outcome === "false") {
      await run.emitter.loopExited(node, { reason: "condition-false", iterations, trace });
      return { status: "succeeded", output: iterationOutput };
    }
    // Condition true but the cap is reached: fail — post-loop nodes may assume it resolved false.
    if (iterations >= maxIterations) {
      await run.emitter.loopExited(node, { reason: "max-iterations-exceeded", iterations, trace });
      return {
        status: "failed",
        error: `while-do "${node.name}": condition still true after max_iterations (${maxIterations}) — the run fails (spec §5.2)`,
      };
    }
    iterations += 1;
    await run.emitter.iterationStarted(node, { iteration: iterations, trace });
    const bodyOutcome = await runLoopIteration(run, node, iterations, iterationOutput, exec);
    if (bodyOutcome.status !== "succeeded") return bodyOutcome;
    iterationOutput = bodyOutcome.output;
  }
}

/** A loop bound — `while-do`'s `max_iterations` or a goto's `max_jumps` — taken as written or interpolated. */
export function resolveBound(
  run: RunContext,
  node: WhileDoNode | GotoNode,
  exec: NodeExecContext,
): number | Extract<SeqOutcome, { status: "failed" }> {
  const [field, value] =
    node.type === "goto" ? ["max_jumps", node.max_jumps] : ["max_iterations", node.max_iterations];
  if (typeof value === "number") return value;
  let resolved: string;
  try {
    resolved = interpolateToString(value, interpolationScope(run.fileConfig, exec.context));
  } catch (err) {
    return { status: "failed", error: describeInterpolationError(node.name, err) };
  }
  const parsed = Number(resolved);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      status: "failed",
      error: `${node.type} "${node.name}": ${field} resolved to "${resolved}", which is not a positive integer`,
    };
  }
  return parsed;
}

/**
 * A goto (spec docs/spec/goto.md §3.2): no run of its own, only a jump naming its target by GUID and
 * passing its incoming output through. The file's top-level walk consumes the jump; walkers hand it up.
 */
export function runGotoNode(
  run: RunContext,
  node: GotoNode,
  incomingOutput: JsonValue,
): SeqOutcome {
  const target = run.file.body.find((candidate) => candidate.name === node.target);
  // The load check refuses a file whose target is not a first-level node, so a miss is a skipped load.
  if (!target)
    return { status: "failed", error: `goto target "${node.target}" not found in this file` };
  return { status: "goto", goto: node.id, target: target.id, output: incomingOutput };
}
