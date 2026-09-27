import { type LogEvent, LogEventSchema } from "@path/schema";
import { ObserverError, type RunObserver } from "../run-observer.js";
import { LOG_FORMAT, type LogBackend } from "./log-backend.js";

// A backend plus its bookkeeping: `active` drops it after a write failure while the survivors still
// get terminal events, and `tail` is its one write queue (mvp spec §8.2).
interface ManagedBackend {
  backend: LogBackend;
  active: boolean;
  tail: Promise<void>;
}

/**
 * A `RunObserver` that stamps each narrated event's per-root-run `seq` (mvp spec §8.1) and fans it
 * out to every backend; events that only persistence records are skipped.
 *
 * Failure policy (§8.2): any *active* backend write failure rejects the hook so `runWorkflow` fails
 * the run, and the failed backend is dropped; terminal events are still emitted best-effort to
 * survivors.
 */
export interface LoggingObserverOptions {
  startSeq?: number;
  append?: boolean;
}

export function createLoggingObserver(
  backends: LogBackend[],
  options: LoggingObserverOptions = {},
): RunObserver {
  const managed: ManagedBackend[] = backends.map((backend) => ({
    backend,
    active: true,
    tail: Promise.resolve(),
  }));
  // `startSeq` keeps a Complete's appended events monotonic instead of colliding at 1.
  let seq = options.startSeq ?? 0;
  const append = options.append ?? false;
  let opened = false;
  let terminated = false;

  // Runs only after that backend's previous op settles, so it never sees concurrent calls. A
  // rejection doesn't poison the chain, but the returned promise still rejects so the caller can
  // react.
  function enqueue(mb: ManagedBackend, op: () => Promise<void>): Promise<void> {
    const done = mb.tail.then(op);
    mb.tail = done.catch(() => {});
    return done;
  }

  // Runs `op` on every still-active backend concurrently, dropping any that reject. `label` fails
  // the run via ObserverError unless `best-effort` — terminal events drop failures without
  // rejecting.
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
        reasons.push(
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      }
    });
    if (!bestEffort && reasons.length > 0)
      throw new ObserverError(`${label}: ${reasons.join("; ")}`);
  }

  async function openAll(runId: string): Promise<void> {
    await fanOut((mb) => mb.backend.open({ runId, format: LOG_FORMAT, append }), {
      label: "log backend open failed",
      bestEffort: false,
    });
  }

  // Delivers one schema-valid event to every active backend. `terminal` events are best-effort
  // (§8.2).
  async function emit(event: LogEvent, terminal: boolean): Promise<void> {
    const parsed = LogEventSchema.parse(event); // uphold "every event validates against the schema"
    await fanOut((mb) => mb.backend.write(parsed), {
      label: "log backend write failed",
      bestEffort: terminal,
    });
  }

  return {
    async observe({ runId, rootRunId, event }) {
      // Opening on the first event also covers a **Complete re-invocation** (ADR 0041), whose
      // re-entered root emits no fresh start but still carries the root run id to open under.
      if (!opened) {
        opened = true;
        await openAll(rootRunId);
      }
      // The root run's own finish is terminal: best-effort, idempotent, then every backend closes.
      const terminal = event?.type === "step-finished" && runId === rootRunId;
      if (terminal) {
        if (terminated) return;
        terminated = true;
      }

      if (event !== null) {
        seq += 1;
        await emit({ ...event, seq } as LogEvent, terminal);
      }

      if (terminal)
        await Promise.allSettled(managed.map((mb) => enqueue(mb, () => mb.backend.close())));
    },
  };
}
