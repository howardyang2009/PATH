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
 * The **Structure Controllers** the engine evaluates itself — `checkpoint`, `branch`, `while-do` — and
 * the Graph Controller's node, `goto` (ADR 0057). None has a run of its own (CONTEXT invariant 1)
 * except a `while-do` iteration's container (ADR 0037). `sequence` needs no runner: it is just a walk,
 * and `parallel` lives in `run-parallel.ts`.
 *
 * A body is always walked through `exec.walk` — the run's own walk, handed in — never an import of it,
 * so this module and the walker cannot form an import cycle.
 */

// A `checkpoint` node: assert its condition over the run's `context` (the branch's snapshot copy
// inside a `parallel`) + the predecessor's `output` (spec §5.2). True → continue; false or a
// strict evaluation error → the run stops as failed (§5.6). Transparent: forwards its
// predecessor's output unchanged — the same object its `output` root read (§5.4). The engine has
// no run for a checkpoint (invariant 1); the event is attributed to this run + the node's id.
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

// A `branch` node: evaluate arms in declaration order, first true `when` wins; else the fallback;
// no match and no `else` fails the run (silent fall-through hides authoring bugs — spec §5.2). A
// condition evaluation error in an arm fails the run outright (§5.6). The taken arm's body runs
// as a nested sequence — transparent to the block's `exec` (same context/cancellation) and seeded
// by the block's predecessor's output (default-input chain, §5.4); its last node's output becomes
// the block's output (§5.4).
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
  if (disposition.kind === "reuse") return { status: "succeeded", output: disposition.output() };
  // The container shares this run's file, config, env, runtime and continue state, and `exec` (the
  // loop's shared blackboard) passes through unchanged, so the body publishes into the loop's context.
  const container = await openContainerRun(run, {
    key: { owner: node, iteration },
    existingRunId: disposition.kind === "reenter" ? disposition.existing.runId : undefined,
    input: iterationInput,
    resume: enterIteration(run.resume, run.file, node.id, iteration),
  });
  // The loop body is a single node (`@2` §4.3), run as a one-node sequence inside the container.
  const outcome = await exec.walk(container.run, [node.node], iterationInput, exec);
  // The body parked at a person-activity leaf (ADR 0041): the container stays `running` (no terminal
  // `run-finished`) and the loop stops here, propagating `awaiting` up. A Complete replay re-enters
  // this iteration container and drives it forward.
  if (outcome.status === "awaiting") return outcome;
  // The load placement rule refuses a goto under `while-do` (spec docs/spec/goto.md §2.2), so a jump
  // never reaches an iteration container.
  if (outcome.status === "goto")
    throw new Error(`while-do "${node.name}": a goto jumped out of its body`);
  await container.finish(outcome);
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
    // Condition true, but the cap has already been reached: the run fails (post-loop nodes may
    // assume the condition resolved false, so an exhausted loop is an authoring error, not an exit).
    if (iterations >= maxIterations) {
      await run.emitter.loopExited(node, { reason: "max-iterations-exceeded", iterations, trace });
      return {
        status: "failed",
        error: `while-do "${node.name}": condition still true after max_iterations (${maxIterations}) — the run fails (spec §5.2)`,
      };
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
 * A goto node (ADR 0053, spec docs/spec/goto.md §3.2): no run of its own, only a jump. It names its
 * target first-level node by GUID and passes its incoming output through unchanged, for the target to
 * read (§4). The file's top-level walk consumes the jump; every walker in between hands it up.
 */
export function runGotoNode(
  run: RunContext,
  node: GotoNode,
  incomingOutput: JsonValue,
): SeqOutcome {
  const target = run.file.body.find((candidate) => candidate.name === node.target);
  // The load check (`@path/schema` goto rules) refuses a file whose target is not a first-level node,
  // so a miss is a caller that skipped the load.
  if (!target)
    return { status: "failed", error: `goto target "${node.target}" not found in this file` };
  return { status: "goto", goto: node.id, target: target.id, output: incomingOutput };
}
