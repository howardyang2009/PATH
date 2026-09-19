import {
  blankRunRecord,
  fromWireLaunchFacts,
  fromWireRunRecord,
  isTerminal,
  type JsonValue,
  type LaunchFacts,
  type LogEvent,
  type RunRecord,
  type RunStatus,
  type RunTreeResponse,
} from "@path/schema";
import { runStatusAfter } from "./event-outcome.js";
import { displayStatusByRun } from "./run-tree.js";

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
 *
 * `waiting` is the quiescent state a `person-activity` run reaches: a leaf is parked `awaiting` and the
 * server has no more events until a `complete`, so it ends the stream although the root run is still
 * `running` (ADR 0038). That is not a dropped connection — the core slow-polls for the continuation
 * rather than hot-looping a reconnect — so the viewer shows a calm "waiting" note, not "reconnecting".
 */
export type StreamPhase = "connecting" | "live" | "waiting" | "reconnecting" | "closed" | "failed";

/**
 * One run's live state: the client's mutable projection of a run row, event-updated. It is the domain
 * `RunRecord` (#257) — the two fields a live view once omitted (`usage`, `estimatedCostUsd`) ride the
 * wire too, so there is no subset shape to maintain in parallel. Kept as a named alias because a
 * client surface reads "run node state" more plainly than "run record".
 */
export type RunNodeState = RunRecord;

/**
 * Decode one wire run row to the client's live node state. It is `fromWireRunRecord` (`@path/schema`)
 * under a client-facing name — the shared inverse of the encode the server ran, so the field set can
 * never drift from the wire shape the way a hand-written decode silently could.
 */
const nodeFromRecord = fromWireRunRecord;

/** The immutable snapshot a view renders. Every mutating call produces a fresh object. */
export interface RunViewState {
  rootRunId: string;
  /** Mirrors the root run's status (the run whose id is `rootRunId`). */
  status: RunStatus;
  output: JsonValue | null;
  /**
   * What the tree was launched with (ADR 0046), decoded to the domain shape — the operator's override
   * input/config and the launch worker-default table, plus the dot-paths in `config` whose values were
   * `$secret`-masked. A per-tree fact, not a per-run one, so it sits on the snapshot beside `output`
   * rather than on any `runs` row. Absent when the launch supplied nothing beyond the workflow file.
   */
  launchFacts?: LaunchFacts;
  /** Every run in the tree, keyed by `runId`. */
  runs: ReadonlyMap<string, RunNodeState>;
  /** The complete chronological narrative, ordered by `seq` (the ordering truth), deduped. */
  narrative: readonly LogEvent[];
  /** Liveness of the event stream feeding `narrative`. */
  stream: StreamPhase;
  /**
   * The status each run should display, keyed by `runId` — a `running` run with an `awaiting` run below
   * it reads `awaiting` (view-only, ADR 0038; `displayStatusByRun` in `run-tree.ts` owns the rule). A
   * surface reads the fact from here rather than re-deriving it from `runs`, so the four run surfaces
   * cannot disagree. A run the map does not hold (the root run before its row arrives) falls back to
   * the record status, which is `status` for the root.
   */
  displayStatus: ReadonlyMap<string, RunStatus>;
  /**
   * The last failure message each run reached, keyed by `runId`. The error text rides the
   * `step-finished` event, not the run record (mvp spec §8.1), so it is folded here — beside the
   * narrative that already holds the events in `seq` order — instead of each surface scanning the
   * narrative for it. A run with no failed finish is absent.
   */
  lastError: ReadonlyMap<string, string>;
  /** The runs parked `awaiting` in this tree, for a surface that counts or badges them (ADR 0042). */
  awaitingRunIds: ReadonlySet<string>;
}

/**
 * The derived facts a run surface reads off the snapshot: what the view answers about a run, without
 * the raw events. A pane that only needs one run's display status, error and the tree's launch facts
 * takes this, so it cannot reach past the view into the event stream.
 */
export type RunViewFacts = Pick<RunViewState, "displayStatus" | "lastError" | "launchFacts">;

export type RunViewListener = (state: RunViewState) => void;

export class RunViewModel {
  private runs = new Map<string, RunNodeState>();
  private narrative: LogEvent[] = [];
  private seenSeqs = new Set<number>();
  private lastErrorById = new Map<string, string>();
  private output: JsonValue | null = null;
  private launchFacts: LaunchFacts | undefined = undefined;
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
    // Decode through the shared inverse, so the camelCase field set can never drift from the wire's
    // snake_case one. Kept absent (not an empty object) when the response carries no `launch_facts`,
    // which is how a launch that supplied nothing reads.
    this.launchFacts = tree.launch_facts !== undefined ? fromWireLaunchFacts(tree.launch_facts) : undefined;
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
    // An event can name a run before its tree row arrives (parentage comes from the row, not the
    // event). Start it blank — all-null, status `pending` — and let the status fold below and a later
    // `hydrate` fill it. `blankRunRecord` builds it from the record's own field manifest, so a new
    // field is never forgotten here.
    const node: RunNodeState =
      existing ??
      blankRunRecord({
        runId: event.run_id,
        rootRunId: this.rootRunId,
        nodeId: event.node_id,
        nodeName: event.node_name,
      });

    // The status transition rules — including the replay guards on `step-started`/`step-awaiting` —
    // live in `runStatusAfter` (`event-outcome.ts`), the one owner of what an event means for a run.
    node.status = runStatusAfter(node.status, event);
    if (event.type === "step-started") {
      node.workerName = event.worker_name;
      node.startedAt ??= event.ts;
    } else if (event.type === "step-finished") {
      node.finishedAt = event.ts;
      // The error text rides the event, not the run row (mvp spec §8.1). The narrative is `seq`-ordered,
      // so the last such event for a run is that run's final word; a `cancelled` finish carries none.
      if (event.error !== undefined) this.lastErrorById.set(event.run_id, event.error);
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
    const runs = new Map(this.runs);
    const awaitingRunIds = new Set<string>();
    for (const run of runs.values()) if (run.status === "awaiting") awaitingRunIds.add(run.runId);
    return {
      rootRunId: this.rootRunId,
      status: this.rootStatus,
      output: this.output,
      launchFacts: this.launchFacts,
      runs,
      narrative: [...this.narrative],
      stream: this.streamPhase,
      // Derived once per snapshot, not once per row: a deep tree costs one walk, and every pane reads
      // the same map instead of re-deciding which rows are loaded.
      displayStatus: displayStatusByRun(runs),
      lastError: new Map(this.lastErrorById),
      awaitingRunIds,
    };
  }

  private commit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
