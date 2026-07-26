import type { LogEvent, RunStatus } from "@path/engine";
import type { JsonValue, Worker } from "@path/schema";
import type { RunTreeResponse, WireRunRecord } from "./wire-types.js";

/**
 * Framework-agnostic view-model for one root run. It assembles the run tree from
 * `GET /v0/runs/:root_run_id` (`hydrate`) and folds the live `LogEvent` stream (`applyEvent`) into a
 * plain reactive state — status transitions per run plus the ordered narrative. No React, no DOM:
 * a view subscribes with `subscribe` and reads `getState`, so the same core drives a React web view
 * or a later React Native one. Pure data-in, snapshot-out.
 */

/**
 * Liveness of the event stream behind the narrative — what a viewer needs to tell "this run is
 * quiet" from "we lost the stream". The core reconnects from the high-water `seq` on its own, so
 * `reconnecting` is a transient state, not an error; `closed` is the terminal one (the root run
 * finished and the server closed the stream for good), and `failed` means reconnect is off or
 * exhausted and no more events are coming.
 */
export type StreamPhase = "connecting" | "live" | "reconnecting" | "closed" | "failed";

/** One run's live state — the mutable projection of a `WireRunRecord` plus event-driven updates. */
export interface RunNodeState {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  nodeId: string | null;
  worker: Worker | null;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  inputRef: string | null;
  outputRef: string | null;
}

/** The immutable snapshot a view renders. Every mutating call produces a fresh object. */
export interface RunViewState {
  rootRunId: string;
  /** Mirrors the root run's status (the run whose id is `rootRunId`). */
  status: RunStatus;
  output: JsonValue | null;
  /** Every run in the tree, keyed by `runId`. */
  runs: ReadonlyMap<string, RunNodeState>;
  /** The complete chronological narrative, ordered by `seq` (the ordering truth), deduped. */
  narrative: readonly LogEvent[];
  /** Liveness of the event stream feeding `narrative`. */
  stream: StreamPhase;
}

export type RunViewListener = (state: RunViewState) => void;

/**
 * A finished run: `step-finished` set it, and nothing after that may move it back. Exported so a
 * surface deciding whether a run can still be acted on (e.g. the viewer's cancel button, #56) names
 * the one terminality check rather than re-deriving the status set.
 */
export function isTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function nodeFromRecord(row: WireRunRecord): RunNodeState {
  return {
    runId: row.run_id,
    rootRunId: row.root_run_id,
    parentRunId: row.parent_run_id,
    nodeId: row.node_id,
    worker: row.worker,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    inputRef: row.input_ref,
    outputRef: row.output_ref,
  };
}

export class RunViewModel {
  private runs = new Map<string, RunNodeState>();
  private narrative: LogEvent[] = [];
  private seenSeqs = new Set<number>();
  private output: JsonValue | null = null;
  private rootStatus: RunStatus = "pending";
  private streamPhase: StreamPhase = "connecting";
  private readonly listeners = new Set<RunViewListener>();
  private snapshot: RunViewState;

  constructor(readonly rootRunId: string) {
    this.snapshot = this.buildSnapshot();
  }

  getState(): RunViewState {
    return this.snapshot;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: RunViewListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Seed the tree from `GET /v0/runs/:root_run_id`. Merges over any event-created run nodes. */
  hydrate(tree: RunTreeResponse): void {
    for (const row of tree.runs) {
      const node = nodeFromRecord(row);
      // A tree read races the run it describes: a re-hydrate taken to learn a new child's parentage
      // can carry rows older than the events already folded in. Rows win on structure (they are the
      // only source of `parent_run_id`), but never walk a finished run backwards.
      const existing = this.runs.get(row.run_id);
      if (existing && isTerminal(existing.status) && !isTerminal(node.status)) {
        node.status = existing.status;
        node.finishedAt ??= existing.finishedAt;
      }
      this.runs.set(row.run_id, node);
    }
    this.output = tree.output;
    const root = this.runs.get(this.rootRunId);
    this.rootStatus = root?.status ?? tree.status;
    this.commit();
  }

  /**
   * Record the event stream's liveness (`connectRunViewModel` drives this from the SSE client). A
   * no-op when the phase is unchanged: a reconnect loop can report the same phase repeatedly, and a
   * snapshot per repeat would re-render every subscriber for nothing.
   */
  setStreamPhase(phase: StreamPhase): void {
    if (this.streamPhase === phase) return;
    this.streamPhase = phase;
    this.commit();
  }

  /** Fold one live `LogEvent` into the state. Duplicate seqs (replay/live overlap) are ignored. */
  applyEvent(event: LogEvent): void {
    if (this.seenSeqs.has(event.seq)) return;
    this.seenSeqs.add(event.seq);
    this.insertNarrative(event);
    this.applyToRun(event);
    this.commit();
  }

  private applyToRun(event: LogEvent): void {
    const existing = this.runs.get(event.run_id);
    const node: RunNodeState = existing ?? {
      runId: event.run_id,
      rootRunId: this.rootRunId,
      parentRunId: null,
      nodeId: event.node_id,
      worker: null,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      inputRef: null,
      outputRef: null,
    };

    if (event.type === "step-started") {
      // A run is terminal for good — a loop iteration spawns a *new* run, it never restarts one
      // (CONTEXT.md: a run is one executing instance of a task). Without this guard a full replay
      // (the default when there is no `Last-Event-ID` to resume from) walks an already-hydrated
      // `succeeded` run back to `running` and forward again, flickering the status on every open.
      if (!isTerminal(node.status)) node.status = "running";
      node.worker = event.worker;
      node.startedAt ??= event.ts;
    } else if (event.type === "step-finished") {
      node.status = event.status;
      node.finishedAt = event.ts;
    }

    this.runs.set(node.runId, node);
    // The top-level status mirrors the root run — the run whose own id is the root id (§4).
    if (node.runId === this.rootRunId) this.rootStatus = node.status;
  }

  /** Insert keeping `narrative` ordered by `seq`; a fast append when the event is the newest. */
  private insertNarrative(event: LogEvent): void {
    const last = this.narrative[this.narrative.length - 1];
    if (!last || event.seq > last.seq) {
      this.narrative.push(event);
      return;
    }
    let i = this.narrative.length;
    while (i > 0 && this.narrative[i - 1]!.seq > event.seq) i--;
    this.narrative.splice(i, 0, event);
  }

  private buildSnapshot(): RunViewState {
    return {
      rootRunId: this.rootRunId,
      status: this.rootStatus,
      output: this.output,
      runs: new Map(this.runs),
      narrative: [...this.narrative],
      stream: this.streamPhase,
    };
  }

  private commit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
