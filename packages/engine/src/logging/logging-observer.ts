import { type Observation, ObserverError, type RunObserver, type RunOutcome } from "../run-observer.js";
import { LOG_FORMAT, type LogBackend } from "./log-backend.js";
import { type LogEvent, LogEventSchema } from "@path/schema";

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
type Envelope = { seq: number; ts: string; run_id: string; node_id: string | null; node_name: string | null };

/** A node's two-part identity (ADR 0007) as control events pass it through the projection. */
type NodeIdentity = { id: string; name: string };

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
 * - **Four observations are never narrated.** `step-stderr`, `step-usage`, `context-changed` and `step-context`
 *   exist for persistence alone; they return `null`.
 * - **The shapes are not 1:1.** `run-started` and `step-started` both become `step-started`
 *   (a workflow-run is its file's implicit root step, invariant 2); `run-finished` and
 *   `step-finished` both become `step-finished`; and `checkpoint-evaluated` splits into
 *   `checkpoint-passed`/`checkpoint-failed`.
 *
 * The `never` guard means a new `Observation` member forces a decision about whether it is narrated.
 * `envelope` is a factory rather than a value because the choice of `node_id`/`node_name` is part of
 * the projection: control-node events carry the control node's own identity, lifecycle events the run's.
 */
export function toLogEvent(o: Observation, envelope: (runId: string, node?: NodeIdentity) => Envelope): LogEvent | null {
  switch (o.type) {
    case "run-started":
      // A workflow-run is its file's implicit root step (invariant 2) and runs a nested run, not a
      // worker (ADR 0021 sub-14) — so its log event's `worker_name` is the step type itself,
      // `"workflow"`, the one string a workflow-shaped step can honestly name here.
      return { type: "step-started", ...envelope(o.runId), step_type: WORKFLOW_STEP_TYPE, worker_name: WORKFLOW_STEP_TYPE };
    case "step-started":
      return { type: "step-started", ...envelope(o.runId), step_type: o.stepType, worker_name: o.workerName };
    case "step-finished":
    case "run-finished":
      return finishedEvent(envelope(o.runId), o);
    case "checkpoint-evaluated":
      return {
        type: o.passed ? "checkpoint-passed" : "checkpoint-failed",
        ...envelope(o.runId, { id: o.nodeId, name: o.nodeName }),
        trace: o.trace,
      };
    case "branch-taken":
      return { type: "branch-taken", ...envelope(o.runId, { id: o.nodeId, name: o.nodeName }), arm: o.arm, trace: o.trace };
    case "branch-no-match":
      return { type: "branch-no-match", ...envelope(o.runId, { id: o.nodeId, name: o.nodeName }), traces: o.traces };
    case "iteration-started":
      return { type: "iteration-started", ...envelope(o.runId, { id: o.nodeId, name: o.nodeName }), iteration: o.iteration, trace: o.trace };
    case "loop-exited":
      return {
        type: "loop-exited",
        ...envelope(o.runId, { id: o.nodeId, name: o.nodeName }),
        reason: o.reason,
        iterations: o.iterations,
        trace: o.trace,
      };
    case "join-applied":
      // A control-node observation (mvp spec §8.1): run_id is the enclosing workflow-run, node_id
      // the `parallel` node — never a run of its own (a logicer has no run, invariant 1).
      return {
        type: "join-applied",
        ...envelope(o.runId, { id: o.nodeId, name: o.nodeName }),
        branches: o.branches,
        published_keys: o.publishedKeys,
        // Present only on a `wait-one` win (wait-one-join.md §8); JSON.stringify drops it when absent.
        winner: o.winner,
      };
    case "run-cancelled":
      // Paired with a `cancelled` step-finished for the same run. `cause` distinguishes a failing
      // sibling branch from an operator stopping the root run (#52).
      return { type: "run-cancelled", ...envelope(o.runId, { id: o.nodeId, name: o.nodeName }), cause: o.cause, cause_run_id: o.causeRunId };
    case "reuse-marker":
      // A reused node's whole narrative (#172): the log carries it where no step-lifecycle pair does,
      // node_id being the reused node's own id and original_run_id the back-reference to the run that
      // holds the real data in the original tree.
      return { type: "reuse-marker", ...envelope(o.runId, { id: o.nodeId, name: o.nodeName }), original_run_id: o.originalRunId };
    // Persistence-only: no log event exists for these (see Observation's docblock).
    case "step-stderr":
    case "step-usage":
    case "context-changed":
    case "step-context":
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
  const nodeNameByRun = new Map<string, string | null>();
  let seq = 0;
  let terminated = false;

  // Lifecycle events default `node_id`/`node_name` to the run's own node (both null for the root, the
  // `workflow` node's GUID + name for a nested run). Control events (#21 checkpoint/branch, #24
  // join-applied/run-cancelled) pass the control node's identity explicitly — they are attributed to
  // the enclosing workflow-step's run but carry the control node's own id and name (ADR 0007).
  function envelope(runId: string, node?: NodeIdentity): Envelope {
    const node_id = node?.id ?? nodeIdByRun.get(runId) ?? null;
    const node_name = node?.name ?? nodeNameByRun.get(runId) ?? null;
    return { seq: (seq += 1), ts: new Date().toISOString(), run_id: runId, node_id, node_name };
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
    async observe(o) {
      // Backends live per root run, and their lifetime rides the root run's own start and finish —
      // which the observer contract guarantees bracket every other observation of the tree.
      if (o.type === "run-started") {
        // null for the root; the `workflow` node's GUID + name for a nested run (#22)
        nodeIdByRun.set(o.runId, o.nodeId);
        nodeNameByRun.set(o.runId, o.nodeName);
        if (o.runId === o.rootRunId) await openAll(o.runId);
      }
      if (o.type === "step-started") {
        nodeIdByRun.set(o.runId, o.nodeId);
        nodeNameByRun.set(o.runId, o.nodeName);
      }

      // The root run's own finish is the terminal event: best-effort, idempotent (runWorkflow may
      // re-drive it while failing), and followed by closing every backend. A *nested* workflow-run
      // finishing is an ordinary step-finished — the root run continues, so a write failure there
      // still fails the run and the backends stay open.
      const terminal = o.type === "run-finished" && o.runId === o.rootRunId;
      if (terminal) {
        if (terminated) return;
        terminated = true;
      }

      const event = toLogEvent(o, envelope);
      if (event !== null) await emit(event, terminal);

      if (terminal) await Promise.allSettled(managed.map((mb) => enqueue(mb, () => mb.backend.close())));
    },
  };
}
