import type { JsonValue, WorkflowFile } from "@path/schema";
import { pickReusedWaitOneWinner } from "./plan-reuse.js";
import type { Cancellation, NodeExecContext, RunContext, SeqOutcome } from "./run-context.js";
import { runSequence } from "./run-workflow.js";

/**
 * The `parallel` block — the engine's densest logic, in one module: three join modes (collect,
 * wait-one, do-not-wait), the block-local cancellation controller that cascades a sibling failure or
 * a race win, and the enclosing-run barrier that drains detached `do-not-wait` branches. Split out of
 * `run-workflow.ts` so the join semantics that carry the spec sit together rather than buried in the
 * executor's leaf-step and sequence code.
 *
 * The recursion into `runSequence` (a branch body is a node sequence) is imported back from the
 * executor: `run-parallel.ts → run-workflow.ts → runNode → runParallelNode` is a function cycle,
 * resolved by ESM before either is called, so it is benign — a value is never read at module-eval
 * time. Detached branches cross the split through `RunContext.detached`: `launchDoNotWait` fills it,
 * `settleDetached` (called by the executor at its exit barrier) drains it.
 */

type ParallelNode = Extract<WorkflowFile["body"][number], { type: "parallel" }>;
type ParallelBranch = ParallelNode["branches"][number];

// One branch's run: which branch, how it ended, and the publishes it buffered (landed only if it is
// the collect join's all-succeeded set, or the wait-one join's winner — wait-one-join.md §4).
interface BranchResult {
  branch: ParallelBranch;
  outcome: SeqOutcome;
  buffer: { [key: string]: JsonValue };
}

// The winning branch of a `wait-one` race, with the output and buffered publishes only it lands (§3, §4).
interface WaitOneWinner {
  branch: ParallelBranch;
  output: JsonValue;
  buffer: { [key: string]: JsonValue };
}

// Land the `wait-one` winner's buffered publishes into context and narrate the win. Only the winner
// lands (wait-one-join.md §4); the block output is the stable `{ winner: { name, output } }` shape so
// a downstream `input` ref resolves without knowing which branch won (§3), and `join-applied` carries
// the winner's human `name` (§8, ADR 0007 — output keys and narration use `name`, never the GUID).
async function landWaitOneWinner(
  run: RunContext,
  node: ParallelNode,
  winner: WaitOneWinner,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const landed = winner.buffer;
  const publishedKeys = Object.keys(landed);
  Object.assign(exec.context, landed);
  if (publishedKeys.length > 0) await exec.onPublish(landed);
  await run.emitter.joinApplied(node, { branches: [winner.branch.name], publishedKeys, winner: winner.branch.name });
  return { status: "succeeded", output: { winner: { name: winner.branch.name, output: winner.output } } };
}

// Drain the owning workflow-run's detached `do-not-wait` branches to terminal (do-not-wait-join.md
// §2). A branch's own body may launch a further `do-not-wait` block against the *same* run while this
// await is in flight, so the loop re-checks: it drains, and any branch pushed meanwhile is caught on
// the next pass. Branch outcomes are already isolated (§5) — a failure fails nothing here — so the
// drained promises are awaited only for completion, not for their result.
export async function settleDetached(run: RunContext): Promise<void> {
  while (run.detached.length > 0) {
    const pending = run.detached.splice(0);
    await Promise.all(pending);
  }
}

// Launch-and-continue (do-not-wait-join.md §2): start every branch and wait for none. Each branch runs
// against its own context snapshot (§5.3) under the run's ambient signal, so an operator abort still
// reaches it (§6), but the block does not consult its status — the branch run is pushed to the owning
// workflow-run's `detached` list and awaited only at that run's exit barrier (§1.1). A branch may not
// `publish` (load-rejected, §4), so its `onPublish` is a no-op and nothing lands. The block discharges
// at once with the empty object (§3) and its successor runs immediately; `join-applied` fires here
// carrying no `winner` and no landed keys (§9).
async function launchDoNotWait(
  run: RunContext,
  node: ParallelNode,
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  for (const branch of node.branches) {
    const branchRun = runSequence(run, branch.body, seedInput, {
      context: { ...exec.context },
      signal: exec.signal,
      cancellation: exec.cancellation,
      onPublish: async () => {},
    }).then(() => {});
    run.detached.push(branchRun);
  }
  await run.emitter.joinApplied(node, { branches: node.branches.map((branch) => branch.name), publishedKeys: [] });
  return { status: "succeeded", output: {} };
}

/**
 * Runs a `parallel` block (mvp spec §5.2–5.4, §5.6). Every branch runs concurrently against its own
 * snapshot of context taken at block entry (siblings never see each other's writes), and its
 * publishes buffer rather than touch the parent context mid-run. The `join` decides what lands:
 *
 * - `collect` — waits for *all* branches; a failing branch fails the block and cancels in-flight
 *   siblings (`sibling-failed`); on all-succeed every buffer lands in branch declaration order and
 *   the output is `{ "<branch-name>": <that branch's last node's output> }`.
 * - `wait-one` — races the branches; the first to `succeed` is the winner, and the still-running
 *   losers are cancelled (`sibling-succeeded`); a branch that *fails* cancels nothing and the race
 *   continues; if every branch fails the block fails with a synthetic aggregate error. Only the
 *   winner's buffer lands and the output is `{ winner: { name, output } }` (wait-one-join.md §2–§5).
 * - `do-not-wait` — launches every branch and awaits none at the join; the block discharges at once
 *   with `{}` and the successor runs while the branches keep going, awaited only at the enclosing
 *   run's exit barrier (`launchDoNotWait`, do-not-wait-join.md §2). No resume short-circuit (§7).
 */
export async function runParallelNode(
  run: RunContext,
  node: ParallelNode,
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  // `runId` labels this block as the fallback cause when a `collect` branch fails without naming its
  // own causing run (below); every observation goes through `run.emitter`, which owns the envelope.
  const { runId } = run.identity;

  // Launch-and-continue is join-mode dispatch, not a race variant: it shares nothing with the
  // block-local win/fail controller below, and resume is cause-blind for it (re-runs, no
  // short-circuit — §7), so it branches off before any of that is built.
  if (node.join === "do-not-wait") {
    return launchDoNotWait(run, node, seedInput, exec);
  }

  // Resume short-circuit (wait-one-join.md §7): replaying a decided race, the winner's steps reuse as
  // `succeeded` while the losers were `cancelled`. Cause-blind resume would re-run the losers — pure
  // waste, and at-least-once it could re-fire their side effects. So the join re-evaluates: find the
  // reused winner and run *only* it, starting no loser at all.
  if (node.join === "wait-one" && run.resume) {
    const reusedWinner = pickReusedWaitOneWinner(node, run.resume.plan);
    if (reusedWinner) {
      const buffer: { [key: string]: JsonValue } = {};
      const outcome = await runSequence(run, reusedWinner.body, seedInput, {
        context: { ...exec.context },
        onPublish: async (updates) => void Object.assign(buffer, updates),
      });
      // The winner reused as `succeeded` in the original tree; its replay reuses those runs and so
      // cannot do otherwise. A non-success here would be an engine bug, not a data-flow outcome.
      if (outcome.status !== "succeeded") return outcome;
      return landWaitOneWinner(run, node, { branch: reusedWinner, output: outcome.output, buffer }, exec);
    }
  }

  const controller = new AbortController();
  // A nested parallel inherits its enclosing block's cancellation: if the outer block aborts, this
  // one aborts too, so this block's own in-flight steps are killed as well.
  const outerSignal = exec.signal;
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }

  let causeRunId: string | null = null;
  let cause: Cancellation["cause"] = null;
  const cancellation: Cancellation = {
    signal: controller.signal,
    get causeRunId() {
      // Read through to the enclosing block at read time, not at block entry: an *outer* sibling
      // may fail after this block started, and its failing run is still this block's cause.
      return causeRunId ?? exec.cancellation?.causeRunId ?? null;
    },
    get cause() {
      return cause ?? exec.cancellation?.cause ?? null;
    },
    trigger(triggerRunId: string) {
      if (cause === null) {
        causeRunId = triggerRunId; // first failing sibling wins
        cause = "sibling-failed";
      }
      controller.abort();
    },
    triggerWin() {
      if (cause === null) cause = "sibling-succeeded"; // first winner wins; no cause run
      controller.abort();
    },
  };

  // The winner of a `wait-one` race: the first branch to complete `succeeded`. Because the event loop
  // serializes branch completions, the first callback to see `succeeded` here is the lowest-`seq` one
  // (§6), so no secondary tie-break is needed.
  let winner: WaitOneWinner | null = null;

  const branchResults: BranchResult[] = await Promise.all(
    node.branches.map(async (branch) => {
      // Each branch runs against a snapshot copy of context (§5.3): its publishes go to the copy
      // (so later nodes in the same branch see them) and buffer for the join — never touching the
      // parent context until the join lands them.
      const branchContext: { [key: string]: JsonValue } = { ...exec.context };
      const buffer: { [key: string]: JsonValue } = {};
      const outcome = await runSequence(run, branch.body, seedInput, {
        context: branchContext,
        signal: controller.signal,
        cancellation,
        onPublish: async (updates) => {
          Object.assign(buffer, updates);
        },
      });
      if (node.join === "collect") {
        if (outcome.status === "failed") {
          cancellation.trigger(outcome.causeRunId ?? runId); // cancel in-flight siblings best-effort
        }
      } else if (outcome.status === "succeeded" && winner === null) {
        // First to succeed wins; a losing branch's failure is ignored and cancels nothing (§2).
        winner = { branch, output: outcome.output, buffer };
        cancellation.triggerWin(); // cancel the still-running losers best-effort
      }
      return { branch, outcome, buffer };
    }),
  );

  if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);

  if (node.join === "wait-one") {
    // An outside abort (an enclosing block failing, an operator cancelling the root run) outranks a
    // local win: the whole subtree is coming down, so the winner's publishes must not land.
    if (outerSignal?.aborted) return { status: "cancelled" };
    if (winner !== null) return landWaitOneWinner(run, node, winner, exec);
    // No winner. A cancelled branch means we were aborted from outside; otherwise every branch
    // failed, and the block fails with a synthetic aggregate distinct from any one branch's error (§2).
    if (branchResults.some((r) => r.outcome.status === "cancelled")) return { status: "cancelled" };
    return { status: "failed", error: `parallel "${node.name}": all ${node.branches.length} wait-one branches failed` };
  }

  // A failing branch fails the block (and thus the run); no publishes land. Report the
  // first-declared failure for determinism.
  for (const { branch, outcome } of branchResults) {
    if (outcome.status === "failed") {
      return {
        status: "failed",
        error: `parallel "${node.name}", branch "${branch.name}": ${outcome.error}`,
      };
    }
  }
  // No local failure but a cancelled branch means the enclosing block aborted us: propagate.
  if (branchResults.some((r) => r.outcome.status === "cancelled")) {
    return { status: "cancelled" };
  }

  // All branches succeeded: land their buffered publishes at the join, in branch declaration
  // order (§5.3). Duplicate keys across siblings are already a load-time error, so no key clashes.
  const landed: { [key: string]: JsonValue } = {};
  const publishedKeys: string[] = [];
  for (const { buffer } of branchResults) {
    for (const [key, value] of Object.entries(buffer)) {
      landed[key] = value;
      publishedKeys.push(key);
    }
  }
  Object.assign(exec.context, landed);
  if (publishedKeys.length > 0) await exec.onPublish(landed);
  await run.emitter.joinApplied(node, { branches: branchResults.map((r) => r.branch.name), publishedKeys });

  // Collect output: keyed by branch name in declaration order, deterministic regardless of
  // completion order and dot-path addressable (§5.4, ADR 0007 — output keys are the human `name`).
  const output: { [key: string]: JsonValue } = {};
  for (const { branch, outcome } of branchResults) {
    output[branch.name] = outcome.status === "succeeded" ? outcome.output : null;
  }
  return { status: "succeeded", output };
}
