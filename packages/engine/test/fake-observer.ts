import type {
  RunEvent,
  RunObserver,
  RunPayload,
  UnsequencedLogEvent,
} from "../src/run-observer.js";

type EventType = UnsequencedLogEvent["type"];

/** A `RunEvent` narrating one log event of type `T`, its payload and root id still beside it. */
export type Narrated<T extends EventType = EventType> = RunEvent & {
  event: Extract<UnsequencedLogEvent, { type: T }>;
};

/** A `RunEvent` carrying one payload of kind `K`. */
export type Recorded<K extends RunPayload["kind"] = RunPayload["kind"]> = RunEvent & {
  payload: Extract<RunPayload, { kind: K }>;
};

export interface FakeObserver extends RunObserver {
  /** Every event in arrival order. */
  all(): RunEvent[];
  /** Call `listener` on each event as it arrives, after recording it. */
  onEvent(listener: (e: RunEvent) => void): void;
  /** The events narrating a log event of `type`, in order. */
  of<T extends EventType>(type: T): Narrated<T>[];
  /** The events carrying a payload of `kind`, in order. */
  records<K extends RunPayload["kind"]>(kind: K): Recorded<K>[];
  /** Workflow-run starts: a `step-started` with the reserved `workflow` step type. */
  runStarts(): Narrated<"step-started">[];
  /** Leaf step starts: every other `step-started`. */
  stepStarts(): Narrated<"step-started">[];
  /** The `step-finished` events of workflow-runs. */
  runFinishes(): Narrated<"step-finished">[];
  /** The `step-finished` events of leaf step runs. */
  stepFinishes(): Narrated<"step-finished">[];
}

/** A `RunObserver` that records through the real seam and answers queries over what it saw. */
export function fakeObserver(): FakeObserver {
  const all: RunEvent[] = [];
  const listeners: ((e: RunEvent) => void)[] = [];
  const of = <T extends EventType>(type: T) =>
    all.filter((e): e is Narrated<T> => e.event?.type === type);
  const isWorkflowRun = (runId: string) =>
    of("step-started").some((e) => e.runId === runId && e.event.step_type === "workflow");
  return {
    observe(e) {
      all.push(e);
      for (const listener of listeners) listener(e);
    },
    all: () => all,
    onEvent: (listener) => void listeners.push(listener),
    of,
    records: <K extends RunPayload["kind"]>(kind: K) =>
      all.filter((e): e is Recorded<K> => e.payload?.kind === kind),
    runStarts: () => of("step-started").filter((e) => e.event.step_type === "workflow"),
    stepStarts: () => of("step-started").filter((e) => e.event.step_type !== "workflow"),
    runFinishes: () => of("step-finished").filter((e) => isWorkflowRun(e.runId)),
    stepFinishes: () => of("step-finished").filter((e) => !isWorkflowRun(e.runId)),
  };
}

/**
 * One event flattened for assertions: its `run_id`, the log event's fields, then the payload's. A
 * record-only fact has no log event, so its `type` is its payload kind (`stderr`, `usage`, `context`).
 */
export function flat(e: RunEvent): { type: string; [field: string]: unknown } {
  const { kind, ...payload } = e.payload ?? { kind: undefined };
  return { run_id: e.runId, ...e.event, ...payload, type: e.event?.type ?? String(kind) };
}
