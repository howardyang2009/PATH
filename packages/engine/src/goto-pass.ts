import { type GotoNode, type JsonValue, must, walkNodes } from "@path/schema";
import { childIdentity, openContainerRun } from "./child-run.js";
import type { PassDivergence } from "./continuation.js";
import { resolveBound } from "./controllers.js";
import type { NodeExecContext, RunContext, SeqOutcome } from "./run-context.js";

/**
 * A workflow-run's **top-level walk** and its **goto passes** (ADR 0053/0054/0060, spec
 * docs/spec/goto.md §3, §8). A file holding a goto walks in **passes**: each forward stretch from
 * the start, or from a jump target, to the next jump taken or the end of the body. Where a pass
 * starts is the run continuation's answer, so Resume pairing and Complete re-entry have one home.
 */

/**
 * One workflow-run's **top-level walk** (ADR 0053/0054, spec docs/spec/goto.md §3): its file's
 * first level walked as an index loop with a jump register. Each pass is a container run under this
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
  const walk = run.continuation.passWalk(gotos, seedInput);
  if ("diverged" in walk) return failDivergedPass(run, walk);
  const { jumpsSpent } = walk;
  let { pass, opener, start, carried, reentered } = walk;
  for (;;) {
    const container = await openContainerRun(run, {
      key: { owner: opener, pass },
      existingRunId: reentered?.runId,
      input: carried,
    });
    if (container.started) await run.emitter.emit(opener, { type: "pass-started", pass });
    reentered = undefined;

    const outcome = await exec.walk(container.run, body.slice(start), carried, exec);
    // A parked leaf keeps its pass `running`, like the workflow-run around it (ADR 0041).
    if (outcome.status === "awaiting") return outcome;
    if (outcome.status !== "goto") {
      await container.finish(outcome);
      return outcome;
    }

    const goto = must(gotos.get(outcome.goto), `goto ${outcome.goto}`);
    const maxJumps = resolveBound(run, goto, exec);
    if (typeof maxJumps !== "number") {
      await container.finish(maxJumps);
      return maxJumps;
    }
    // `runGotoNode` names a first-level node of this same file, so the target is always indexed.
    const targetIndex = must(indexById.get(outcome.target), `goto target ${outcome.target}`);
    const target = must(body[targetIndex], `goto target ${outcome.target}`);
    const spent = jumpsSpent.get(goto.id) ?? 0;
    // Cause first (ADR 0061 §5): the goto event, then the closing pass's step-finished.
    if (spent >= maxJumps) {
      await run.emitter.emit(goto, {
        type: "goto-exhausted",
        target_node_id: target.id,
        target_node_name: target.name,
        max_jumps: maxJumps,
        pass,
      });
      const exhausted: SeqOutcome = {
        status: "failed",
        error: `goto "${goto.name}": max_jumps (${maxJumps}) exhausted`,
      };
      await container.finish(exhausted);
      return exhausted;
    }
    jumpsSpent.set(goto.id, spent + 1);
    await run.emitter.emit(goto, {
      type: "goto-taken",
      target_node_id: target.id,
      target_node_name: target.name,
      jump: spent + 1,
      max_jumps: maxJumps,
      pass: pass + 1,
    });
    await container.finish({ status: "succeeded", output: outcome.output });

    pass += 1;
    opener = goto;
    start = targetIndex;
    carried = outcome.output;
  }
}

/**
 * A Complete whose running pass no longer matches the reloaded file (ADR 0060 §2): the pass and,
 * with it, the workflow-run fail. A parked leaf in this pass is committed first with the supplied
 * output, so a later Resume reuses it instead of asking for it again.
 */
async function failDivergedPass(run: RunContext, divergence: PassDivergence): Promise<SeqOutcome> {
  const { commit } = divergence;
  if (commit !== undefined) {
    await run.emitter
      .step(commit.node, commit.runId)
      .finished({ status: "succeeded", output: commit.output });
  }
  const passRow = divergence.diverged;
  const failed: SeqOutcome = { status: "failed", error: divergence.error };
  const owner =
    passRow.nodeId === null
      ? null
      : { id: passRow.nodeId, name: must(passRow.nodeName, "node name of a pass run") };
  const pass = must(passRow.pass, "pass number of a pass run");
  const identity = childIdentity(run.identity, { owner, pass }, passRow.runId);
  await run.emitter.child(identity).runFinished(failed);
  return failed;
}
