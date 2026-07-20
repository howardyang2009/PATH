import { ObserverError, type RunObserver } from "../run-observer.js";
import { LOG_FORMAT, type LogBackend } from "./log-backend.js";
import { type LogEvent, LogEventSchema } from "./log-event.js";

// Every workflow-run is its file's implicit root step (invariant 2), so its lifecycle events
// report this step_type: the root run with `node_id: null`, a nested workflow-step's run (#22)
// with the `workflow` node's real id.
const WORKFLOW_STEP_TYPE = "workflow";

// A backend plus the engine-side bookkeeping the seam requires: an `active` flag (a backend is
// dropped after its first write failure — surviving backends still receive terminal events) and a
// `tail` promise so writes to one backend never run concurrently (mvp spec §8.2: one write queue
// per backend).
interface ManagedBackend {
  backend: LogBackend;
  active: boolean;
  tail: Promise<void>;
}

/**
 * A `RunObserver` (see run-observer.ts) that turns run/step lifecycle hooks into the typed log-event
 * stream (mvp spec §8.1) and fans it out to every backend. Envelope assembly, `seq`, and (later,
 * #20) masking happen here, engine-side — backends are dumb sinks.
 *
 * Failure policy (§8.2, audit-first): any *active* backend write failure rejects the hook so
 * `runWorkflow` fails the run; the failed backend is dropped, and terminal events (the root
 * `step-finished` + `close`) are still emitted best-effort to the survivors. Terminal emission never
 * rejects — the run is already ending.
 */
export function createLoggingObserver(backends: LogBackend[]): RunObserver {
  const managed: ManagedBackend[] = backends.map((backend) => ({ backend, active: true, tail: Promise.resolve() }));
  const nodeIdByRun = new Map<string, string | null>();
  let seq = 0;
  let terminated = false;

  // Lifecycle events default `node_id` to the run's own node (null for the root, the workflow
  // node's id for a nested run). Control events (#21 checkpoint/branch, #24 join-applied/
  // run-cancelled) pass the control node's id explicitly — they are attributed to the enclosing
  // workflow-step's run but carry the control node's id.
  function envelope(
    runId: string,
    nodeId?: string,
  ): { seq: number; ts: string; run_id: string; node_id: string | null } {
    const node_id = nodeId ?? nodeIdByRun.get(runId) ?? null;
    return { seq: (seq += 1), ts: new Date().toISOString(), run_id: runId, node_id };
  }

  // Serialize an op onto a backend's queue: it runs only after that backend's previous op settles,
  // so a backend never sees concurrent calls. A rejection doesn't poison the chain (the tail keeps
  // draining), but the returned promise still rejects so the caller can react.
  function enqueue(mb: ManagedBackend, op: () => Promise<void>): Promise<void> {
    const done = mb.tail.then(op);
    mb.tail = done.catch(() => {});
    return done;
  }

  // Run `op` on every still-active backend concurrently (different backends may write in parallel;
  // only per-backend order is serialized) and drop any that reject. `label` fails the run via
  // ObserverError unless `best-effort` — terminal events (§8.2) drop failures without rejecting.
  async function fanOut(
    op: (mb: ManagedBackend) => Promise<void>,
    { label, bestEffort }: { label: string; bestEffort: boolean },
  ): Promise<void> {
    const targets = managed.filter((mb) => mb.active);
    const results = await Promise.allSettled(targets.map((mb) => enqueue(mb, () => op(mb))));
    const reasons: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        targets[i]!.active = false;
        reasons.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    });
    if (!bestEffort && reasons.length > 0) throw new ObserverError(`${label}: ${reasons.join("; ")}`);
  }

  async function openAll(runId: string): Promise<void> {
    await fanOut((mb) => mb.backend.open({ runId, format: LOG_FORMAT }), { label: "log backend open failed", bestEffort: false });
  }

  // Deliver one already-assembled, schema-valid event to every active backend. `terminal` events
  // (§8.2) are best-effort: failures still drop the backend but never reject the run.
  async function emit(event: LogEvent, terminal: boolean): Promise<void> {
    const parsed = LogEventSchema.parse(event); // uphold "every event validates against the schema"
    await fanOut((mb) => mb.backend.write(parsed), { label: "log backend write failed", bestEffort: terminal });
  }

  return {
    async runStarted({ runId, rootRunId, nodeId, worker }) {
      nodeIdByRun.set(runId, nodeId); // null for the root run; the `workflow` node's id for a nested run (#22)
      if (runId === rootRunId) await openAll(runId); // backends live per root run, not per nested run
      await emit({ type: "step-started", ...envelope(runId), step_type: WORKFLOW_STEP_TYPE, worker }, false);
    },

    async stepStarted({ runId, nodeId, stepType, worker }) {
      nodeIdByRun.set(runId, nodeId);
      await emit({ type: "step-started", ...envelope(runId), step_type: stepType, worker }, false);
    },

    async stepFinished(info) {
      await emit(finishedEvent(envelope(info.runId), info), false);
    },

    async joinApplied({ runId, nodeId, branches, publishedKeys }) {
      // A control-node observation (mvp spec §8.1): run_id is the enclosing workflow-run, node_id
      // the `parallel` node — never a run of its own (a logicer has no run, invariant 1).
      await emit(
        { type: "join-applied", ...envelope(runId, nodeId), branches, published_keys: publishedKeys },
        false,
      );
    },

    async runCancelled({ runId, nodeId, causeRunId }) {
      // The best-effort cancellation of an in-flight sibling (mvp spec §5.6): run_id/node_id are the
      // cancelled step run and its node, paired with a `cancelled` step-finished for the same run.
      await emit({ type: "run-cancelled", ...envelope(runId, nodeId), cause_run_id: causeRunId }, false);
    },

    async runFinished(info) {
      if (info.runId !== info.rootRunId) {
        // A nested workflow-run finishing is an ordinary step-finished — the root run continues,
        // so a write failure here still fails the run (not best-effort) and backends stay open.
        await emit(finishedEvent(envelope(info.runId), info), false);
        return;
      }
      if (terminated) return; // idempotent: runWorkflow may re-drive the terminal event while failing
      terminated = true;
      await emit(finishedEvent(envelope(info.runId), info), true);
      await Promise.allSettled(managed.map((mb) => enqueue(mb, () => mb.backend.close())));
    },

    async checkpointEvaluated({ runId, nodeId, passed, trace }) {
      const type = passed ? "checkpoint-passed" : "checkpoint-failed";
      await emit({ type, ...envelope(runId, nodeId), trace }, false);
    },

    async branchTaken({ runId, nodeId, arm, trace }) {
      await emit({ type: "branch-taken", ...envelope(runId, nodeId), arm, trace }, false);
    },

    async branchNoMatch({ runId, nodeId, traces }) {
      await emit({ type: "branch-no-match", ...envelope(runId, nodeId), traces }, false);
    },

    async iterationStarted({ runId, nodeId, iteration, trace }) {
      await emit({ type: "iteration-started", ...envelope(runId, nodeId), iteration, trace }, false);
    },

    async loopExited({ runId, nodeId, reason, iterations, trace }) {
      await emit({ type: "loop-exited", ...envelope(runId, nodeId), reason, iterations, trace }, false);
    },
  };

  function finishedEvent(
    env: ReturnType<typeof envelope>,
    outcome: { status: "succeeded"; output: unknown } | { status: "failed"; error?: string } | { status: "cancelled" },
  ): LogEvent {
    // A `cancelled` step-finished (#24) carries no error — the cause is narrated by run-cancelled.
    return outcome.status === "failed" && outcome.error !== undefined
      ? { type: "step-finished", ...env, status: "failed", error: outcome.error }
      : { type: "step-finished", ...env, status: outcome.status };
  }
}
