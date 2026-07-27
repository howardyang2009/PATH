import { type Observation, ObserverError, type RunObserver, type RunOutcome } from "../run-observer.js";
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

/** The shared log-event envelope (mvp spec §8.1) — `seq` is the ordering truth per root run. */
type Envelope = { seq: number; ts: string; run_id: string; node_id: string | null };

// A `cancelled` step-finished (#24) carries no error — the cause is narrated by run-cancelled.
function finishedEvent(env: Envelope, outcome: RunOutcome): LogEvent {
  return outcome.status === "failed" && outcome.error !== undefined
    ? { type: "step-finished", ...env, status: "failed", error: outcome.error }
    : { type: "step-finished", ...env, status: outcome.status };
}

/**
 * Project one observation onto the log narrative (#62), or `null` when it is not narrated.
 *
 * This function is where "what the log stream is" lives. Three kinds of difference between the two
 * unions are resolved here, and nowhere else:
 *
 * - **Payloads are dropped.** `input`, `output` and `context` reach the log only as blob refs on the
 *   run row (mvp spec §6), so the events carry none of them.
 * - **Three observations are never narrated.** `step-stderr`, `step-usage` and `context-changed`
 *   exist for persistence alone; they return `null`.
 * - **The shapes are not 1:1.** `run-started` and `step-started` both become `step-started`
 *   (a workflow-run is its file's implicit root step, invariant 2); `run-finished` and
 *   `step-finished` both become `step-finished`; and `checkpoint-evaluated` splits into
 *   `checkpoint-passed`/`checkpoint-failed`.
 *
 * The `never` guard means a new `Observation` member forces a decision about whether it is narrated.
 * `envelope` is a factory rather than a value because the choice of `node_id` is part of the
 * projection: control-node events carry the control node's own id, lifecycle events the run's.
 */
export function toLogEvent(o: Observation, envelope: (runId: string, nodeId?: string) => Envelope): LogEvent | null {
  switch (o.type) {
    case "run-started":
      return { type: "step-started", ...envelope(o.runId), step_type: WORKFLOW_STEP_TYPE, worker: o.worker };
    case "step-started":
      return { type: "step-started", ...envelope(o.runId), step_type: o.stepType, worker: o.worker };
    case "step-finished":
    case "run-finished":
      return finishedEvent(envelope(o.runId), o);
    case "checkpoint-evaluated":
      return {
        type: o.passed ? "checkpoint-passed" : "checkpoint-failed",
        ...envelope(o.runId, o.nodeId),
        trace: o.trace,
      };
    case "branch-taken":
      return { type: "branch-taken", ...envelope(o.runId, o.nodeId), arm: o.arm, trace: o.trace };
    case "branch-no-match":
      return { type: "branch-no-match", ...envelope(o.runId, o.nodeId), traces: o.traces };
    case "iteration-started":
      return { type: "iteration-started", ...envelope(o.runId, o.nodeId), iteration: o.iteration, trace: o.trace };
    case "loop-exited":
      return {
        type: "loop-exited",
        ...envelope(o.runId, o.nodeId),
        reason: o.reason,
        iterations: o.iterations,
        trace: o.trace,
      };
    case "join-applied":
      // A control-node observation (mvp spec §8.1): run_id is the enclosing workflow-run, node_id
      // the `parallel` node — never a run of its own (a logicer has no run, invariant 1).
      return {
        type: "join-applied",
        ...envelope(o.runId, o.nodeId),
        branches: o.branches,
        published_keys: o.publishedKeys,
      };
    case "run-cancelled":
      // Paired with a `cancelled` step-finished for the same run. `cause` distinguishes a failing
      // sibling branch from an operator stopping the root run (#52).
      return { type: "run-cancelled", ...envelope(o.runId, o.nodeId), cause: o.cause, cause_run_id: o.causeRunId };
    // Persistence-only: no log event exists for these (see Observation's docblock).
    case "step-stderr":
    case "step-usage":
    case "context-changed":
      return null;
    default: {
      const exhaustive: never = o;
      return exhaustive;
    }
  }
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

    async runCancelled({ runId, nodeId, cause, causeRunId }) {
      // A best-effort cancellation (mvp spec §5.6): run_id/node_id are the cancelled step run and its
      // node, paired with a `cancelled` step-finished for the same run. `cause` distinguishes a
      // failing sibling branch from an operator stopping the root run (#52).
      await emit({ type: "run-cancelled", ...envelope(runId, nodeId), cause, cause_run_id: causeRunId }, false);
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
}
