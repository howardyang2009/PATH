import {
  type GotoNode,
  isPassRun,
  type JsonValue,
  type RunRecord,
  serialOrder,
  type WorkflowFile,
  walkNodes,
} from "@path/schema";
import { childIdentity, openContainerRun } from "./child-run.js";
import { targetLeafUnder } from "./continuation.js";
import { resolveBound } from "./controllers.js";
import { RUN_BLOB_FILE } from "./persistence/paths.js";
import { passResumer, type RunResume } from "./resume-plan.js";
import type { NodeExecContext, RunContext, SeqOutcome } from "./run-context.js";

/**
 * A workflow-run's **top-level walk** and its **goto passes** (ADR 0053/0054/0060, spec
 * docs/spec/goto.md §3, §8). A file holding a goto walks in **passes**: each forward stretch from the
 * start, or from a jump target, to the next jump taken or the end of the body. Both Continuation modes
 * answer here, so the rules for a pass's first recorded node and its Resume pairing have one home.
 */

type WorkflowNode = WorkflowFile["body"][number];

/** Where a top-level walk with passes starts. */
export interface PassWalkStart {
  pass: number;
  /** The starting pass's opener; `null` for pass 1. */
  opener: GotoNode | null;
  start: number;
  /** The walk's seed for pass 1, the recorded pass input on a re-entry. */
  carried: JsonValue;
  jumpsSpent: Map<string, number>;
  /** The recorded `running` pass a Complete re-enters in place (same id, no `run-started`). */
  reentered: RunRecord | undefined;
  /** The resume state for each pass as the walk opens it; `undefined` when not resuming. */
  resumeFor: (pass: number, opener: GotoNode | null) => RunResume | undefined;
}

/** A Complete whose running pass no longer matches the reloaded file (ADR 0060 §2). */
export interface PassDivergence {
  diverged: RunRecord;
  error: string;
}

/** A goto target's first node in serial order — the node a pass opened at (ADR 0064). */
export function passFirstNode(target: WorkflowNode): WorkflowNode | undefined {
  return serialOrder([target])[0];
}

/** The goto pass rows recorded under one workflow-run, in ordinal order; also its per-goto jump counts. */
export function recordedPasses(rows: readonly RunRecord[], parentRunId: string): RunRecord[] {
  return rows
    .filter((r) => r.parentRunId === parentRunId && isPassRun(r))
    .sort((a, b) => a.pass! - b.pass!);
}

/**
 * The start of one workflow-run's top-level walk over a file holding gotos, and the divergence check
 * a Complete's reloaded file must pass (ADR 0060).
 */
export function passWalkStart(
  run: Pick<RunContext, "file" | "identity" | "resume" | "continue">,
  gotos: ReadonlyMap<string, GotoNode>,
  seedInput: JsonValue,
): PassWalkStart | PassDivergence {
  const resumer = run.resume && passResumer(run.resume, run.file);
  const walk: PassWalkStart = {
    pass: 1,
    opener: null,
    start: 0,
    carried: seedInput,
    jumpsSpent: new Map(),
    reentered: undefined,
    resumeFor: (pass, opener) => resumer?.(pass, opener?.id ?? null),
  };
  const state = run.continue;
  if (!state) return walk;

  // Complete (ADR 0060, spec §8.2): follow the record. Closed passes are facts, not re-walked.
  const passes = recordedPasses(state.existingRuns, run.identity.runId);
  for (const recorded of passes) {
    if (recorded.nodeId !== null)
      walk.jumpsSpent.set(recorded.nodeId, (walk.jumpsSpent.get(recorded.nodeId) ?? 0) + 1);
  }
  const reentered = passes.find((recorded) => recorded.status === "running");
  if (!reentered) return walk;
  walk.reentered = reentered;
  walk.pass = reentered.pass!;
  walk.carried = state.readBlob(reentered, RUN_BLOB_FILE.input);
  if (walk.pass === 1) return walk;

  // Pass N starts at its opening goto's target, which must be the node the pass recorded first: a
  // different tail would no longer match the pass's rows. `existingRuns` is in start order.
  const body = run.file.body;
  const goto = reentered.nodeId === null ? undefined : gotos.get(reentered.nodeId);
  const target = goto && body.find((candidate) => candidate.name === goto.target);
  const recordedFirst = state.existingRuns.find((r) => r.parentRunId === reentered.runId);
  if (!goto || !target || passFirstNode(target)?.id !== recordedFirst?.nodeId) {
    return {
      diverged: reentered,
      error:
        `Complete replay diverged: pass ${walk.pass} was opened by goto "${goto?.name ?? reentered.nodeName}" ` +
        `whose target is now "${goto?.target ?? "(none)"}", recorded "${recordedFirst?.nodeName ?? "(none)"}"`,
    };
  }
  walk.opener = goto;
  walk.start = body.indexOf(target);
  return walk;
}

/**
 * One workflow-run's **top-level walk** (ADR 0053/0054, spec docs/spec/goto.md §3): its file's first
 * level walked as an index loop with a jump register. Each pass is a container run under this
 * workflow-run sharing its context, so context is one last-writer-wins blackboard across passes
 * (ADR 0059). A jump is counted per goto; the jump after the last one `max_jumps` allows fails the
 * pass and, with it, the workflow-run. The target's incoming output is the goto's passed-through
 * output, forward or backward (ADR 0055).
 */
export async function runTopLevelWalk(
  run: RunContext,
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const body = run.file.body;
  const gotos = new Map<string, GotoNode>();
  for (const node of walkNodes(body)) if (node.type === "goto") gotos.set(node.id, node);
  if (gotos.size === 0) return exec.walk(run, body, seedInput, exec);
  const indexById = new Map(body.map((node, index) => [node.id, index]));

  // Pass 1 for a launch or a Resume, the recorded running pass for a Complete (ADR 0060).
  const walk = passWalkStart(run, gotos, seedInput);
  if ("diverged" in walk) return failDivergedPass(run, walk.diverged, walk.error);
  const { jumpsSpent, resumeFor } = walk;
  let { pass, opener, start, carried, reentered } = walk;
  for (;;) {
    const container = await openContainerRun(run, {
      key: { owner: opener, pass },
      existingRunId: reentered?.runId,
      input: carried,
      resume: resumeFor(pass, opener),
    });
    if (container.started) await run.emitter.passStarted(opener, { pass });
    reentered = undefined;

    const outcome = await exec.walk(container.run, body.slice(start), carried, exec);
    // A parked leaf keeps its pass `running`, like the workflow-run around it (ADR 0041).
    if (outcome.status === "awaiting") return outcome;
    if (outcome.status !== "goto") {
      await container.finish(outcome);
      return outcome;
    }

    const goto = gotos.get(outcome.goto)!;
    const maxJumps = resolveBound(run, goto, exec);
    if (typeof maxJumps !== "number") {
      await container.finish(maxJumps);
      return maxJumps;
    }
    // `runGotoNode` names a first-level node of this same file, so the target is always indexed.
    const targetIndex = indexById.get(outcome.target)!;
    const target = body[targetIndex]!;
    const spent = jumpsSpent.get(goto.id) ?? 0;
    // Cause first (ADR 0061 §5): the goto event, then the closing pass's step-finished.
    if (spent >= maxJumps) {
      await run.emitter.gotoExhausted(goto, { target, maxJumps, pass });
      const exhausted: SeqOutcome = {
        status: "failed",
        error: `goto "${goto.name}": max_jumps (${maxJumps}) exhausted`,
      };
      await container.finish(exhausted);
      return exhausted;
    }
    jumpsSpent.set(goto.id, spent + 1);
    await run.emitter.gotoTaken(goto, { target, jump: spent + 1, maxJumps, pass: pass + 1 });
    await container.finish({ status: "succeeded", output: outcome.output });

    pass += 1;
    opener = goto;
    start = targetIndex;
    carried = outcome.output;
  }
}

/**
 * A Complete whose running pass no longer matches the reloaded file (ADR 0060 §2): the pass and, with
 * it, the workflow-run fail. A parked leaf in this pass is committed first with the supplied output,
 * so a later Resume reuses it instead of asking for it again.
 */
async function failDivergedPass(
  run: RunContext,
  passRow: RunRecord,
  error: string,
): Promise<SeqOutcome> {
  const state = run.continue!;
  if (targetLeafUnder(state, passRow.runId)) {
    const leaf = state.existingRuns.find((r) => r.runId === state.target.stepRunId)!;
    await run.emitter
      .step({ id: leaf.nodeId!, name: leaf.nodeName! }, leaf.runId)
      .finished({ status: "succeeded", output: state.target.output });
  }
  const failed: SeqOutcome = { status: "failed", error };
  const owner = passRow.nodeId === null ? null : { id: passRow.nodeId, name: passRow.nodeName! };
  const identity = childIdentity(run.identity, { owner, pass: passRow.pass! }, passRow.runId);
  await run.emitter.child(identity).runFinished(failed);
  return failed;
}
