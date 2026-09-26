import type { JsonValue, WorkflowFile } from "@path/schema";
import { blockCancellation } from "./cancellation.js";
import { pickReusedWaitOneWinner } from "./plan-reuse.js";
import type { NodeExecContext, RunContext, SeqOutcome } from "./run-context.js";

/** The `parallel` block: collect/wait-one/do-not-wait joins, the block-local cancellation cascade, and
 * the barrier draining detached branches. Branches run through `NodeExecContext.walk` (no module cycle). */

type ParallelNode = Extract<WorkflowFile["body"][number], { type: "parallel" }>;
type ParallelBranch = ParallelNode["branches"][number];

// One branch's run: which branch, how it ended, and the publishes it buffered for the join.
interface BranchResult {
  branch: ParallelBranch;
  outcome: SeqOutcome;
  buffer: { [key: string]: JsonValue };
}

// The winning branch of a `wait-one` race, with the output and buffered publishes only it lands.
interface WaitOneWinner {
  branch: ParallelBranch;
  output: JsonValue;
  buffer: { [key: string]: JsonValue };
}

// Land only the winner's buffered publishes and narrate the win; the stable `{ winner: { name, output } }`
// shape lets a downstream `input` ref resolve without knowing which branch won, keyed by human `name`.
async function landWaitOneWinner(
  run: RunContext,
  node: ParallelNode,
  winner: WaitOneWinner,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const publishedKeys = await landAtJoin(exec, winner.buffer);
  await run.emitter.joinApplied(node, {
    branches: [winner.branch.name],
    publishedKeys,
    winner: winner.branch.name,
  });
  return {
    status: "succeeded",
    output: { winner: { name: winner.branch.name, output: winner.output } },
  };
}

/** A branch's snapshot of context: siblings never see each other's writes, and publishes buffer until
 * the join lands them. */
function branchView(
  exec: NodeExecContext,
  overrides: Pick<NodeExecContext, "signal" | "cancellation"> | Record<string, never> = {},
): { exec: NodeExecContext; buffer: { [key: string]: JsonValue } } {
  const buffer: { [key: string]: JsonValue } = {};
  return {
    exec: {
      ...exec,
      ...overrides,
      context: { ...exec.context },
      onPublish: async (updates) => void Object.assign(buffer, updates),
    },
    buffer,
  };
}

/** Land buffered publishes into the enclosing context at the join, returning the keys that landed. */
async function landAtJoin(
  exec: NodeExecContext,
  landed: { [key: string]: JsonValue },
): Promise<string[]> {
  const publishedKeys = Object.keys(landed);
  Object.assign(exec.context, landed);
  if (publishedKeys.length > 0) await exec.onPublish(landed);
  return publishedKeys;
}

// Drain the run's detached `do-not-wait` branches to terminal. A drained branch's body may launch a
// further detached branch against the same run mid-await, so the loop re-checks after each pass.
export async function settleDetached(run: RunContext): Promise<void> {
  while (run.detached.length > 0) {
    const pending = run.detached.splice(0);
    await Promise.all(pending);
  }
}

// Launch-and-continue (do-not-wait): start every branch and wait for none; each runs against its own
// context snapshot, pushed to `run.detached` and awaited only at the run's exit barrier. No publishes.
async function launchDoNotWait(
  run: RunContext,
  node: ParallelNode,
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  for (const branch of node.branches) {
    const branchRun = exec.walk(run, [branch], seedInput, branchView(exec).exec).then(() => {});
    run.detached.push(branchRun);
  }
  await run.emitter.joinApplied(node, {
    branches: node.branches.map((branch) => branch.name),
    publishedKeys: [],
  });
  return { status: "succeeded", output: {} };
}

/** Runs a `parallel` block (spec §5.2–5.6): branches run concurrently against their own context
 * snapshots, and the join decides what lands — `collect` waits for all and fails on first failure,
 * `wait-one` lands only the first success, `do-not-wait` launches and continues. */
export async function runParallelNode(
  run: RunContext,
  node: ParallelNode,
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { runId } = run.identity;

  // do-not-wait shares nothing with the win/fail controller below, and resume is cause-blind for it
  // (re-runs, no short-circuit), so it branches off before any of that is built.
  if (node.join === "do-not-wait") {
    return launchDoNotWait(run, node, seedInput, exec);
  }

  // Resume short-circuit: replaying a decided race reuses the winner and cancels the losers, so find
  // the reused winner and run only it — cause-blind resume could re-fire a loser's side effects.
  if (node.join === "wait-one" && run.resume) {
    const reusedWinner = pickReusedWaitOneWinner(node, run.resume.plan);
    if (reusedWinner) {
      const view = branchView(exec);
      const outcome = await exec.walk(run, [reusedWinner], seedInput, view.exec);
      // The winner reused as `succeeded` originally, so a non-success here would be an engine bug.
      if (outcome.status !== "succeeded") return outcome;
      return landWaitOneWinner(
        run,
        node,
        { branch: reusedWinner, output: outcome.output, buffer: view.buffer },
        exec,
      );
    }
  }

  // The enclosing execution's signal: a `wait-one` outside abort outranks a local win.
  const outerSignal = exec.signal;
  const { cancellation, dispose } = blockCancellation(exec.cancellation, outerSignal);

  // The winner of a `wait-one` race: the first branch to complete `succeeded`. The event loop
  // serializes completions, so the first to see success is the lowest-`seq` one — no tie-break needed.
  let winner: WaitOneWinner | null = null;

  const branchResults: BranchResult[] = await Promise.all(
    node.branches.map(async (branch) => {
      const { exec: branchExec, buffer } = branchView(exec, {
        signal: cancellation.signal,
        cancellation,
      });
      const outcome = await exec.walk(run, [branch], seedInput, branchExec);
      if (node.join === "collect") {
        if (outcome.status === "failed") {
          cancellation.trigger(outcome.causeRunId ?? runId); // best-effort
        }
      } else if (outcome.status === "succeeded" && winner === null) {
        // First to succeed wins; a losing branch's failure cancels nothing.
        winner = { branch, output: outcome.output, buffer };
        cancellation.triggerWin(); // best-effort
      }
      return { branch, outcome, buffer };
    }),
  );

  dispose();

  if (node.join === "wait-one") {
    // An outside abort outranks a local win: the subtree is coming down, so publishes must not land.
    if (outerSignal?.aborted) return { status: "cancelled" };
    if (winner !== null) return landWaitOneWinner(run, node, winner, exec);
    // No winner: a cancelled branch means an outside abort, otherwise every branch failed and the
    // block fails with a synthetic aggregate distinct from any one branch's error.
    if (branchResults.some((r) => r.outcome.status === "cancelled")) return { status: "cancelled" };
    // Park-at-join (ADR 0042): a branch parked at a person-activity leaf may still win once Completed,
    // so the race is undecided — park with `awaiting`. Only with no awaiting branch is it all-failed.
    if (branchResults.some((r) => r.outcome.status === "awaiting")) return { status: "awaiting" };
    return {
      status: "failed",
      error: `parallel "${node.name}": all ${node.branches.length} wait-one branches failed`,
    };
  }

  // A failing branch fails the block and no publishes land; report the first-declared failure.
  for (const { branch, outcome } of branchResults) {
    if (outcome.status === "failed") {
      return {
        status: "failed",
        error: `parallel "${node.name}", branch "${branch.name}": ${outcome.error}`,
      };
    }
  }
  if (branchResults.some((r) => r.outcome.status === "cancelled")) {
    return { status: "cancelled" };
  }

  // Park-at-join (ADR 0042): `collect` waits for all branches, so one parked branch parks the block —
  // nothing lands and a Complete replay re-drives it. Ordered after failed/cancelled so a real failure
  // still fails the block rather than parking it.
  if (branchResults.some((r) => r.outcome.status === "awaiting")) {
    return { status: "awaiting" };
  }

  // All branches succeeded: land their buffered publishes in declaration order; duplicate keys across
  // siblings are already a load-time error.
  const publishedKeys = await landAtJoin(
    exec,
    Object.assign({}, ...branchResults.map((r) => r.buffer)),
  );
  await run.emitter.joinApplied(node, {
    branches: branchResults.map((r) => r.branch.name),
    publishedKeys,
  });

  // Collect output: keyed by branch name in declaration order, deterministic regardless of completion
  // order and dot-path addressable (output keys are the human `name`, ADR 0007).
  const output: { [key: string]: JsonValue } = {};
  for (const { branch, outcome } of branchResults) {
    output[branch.name] = outcome.status === "succeeded" ? outcome.output : null;
  }
  return { status: "succeeded", output };
}
