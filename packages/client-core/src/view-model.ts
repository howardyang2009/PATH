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

/** Framework-agnostic view-model for one root run: `hydrate` seeds the run tree from
 * `GET /v0/runs/:root_run_id`, `applyEvent` folds the live stream. Pure data-in, snapshot-out. */

/** Liveness of the stream behind the narrative: `reconnecting` is transient (the core reconnects by
 * itself), `closed` is terminal, `failed` means no more events come. `waiting` is the quiescent
 * leaf-parked state (ADR 0038) — a calm note, not a drop. */
export type StreamPhase = "connecting" | "live" | "waiting" | "reconnecting" | "closed" | "failed";

/** One run's live state: the domain `RunRecord`, event-updated; named for the client surface. */
export type RunNodeState = RunRecord;

/** `fromWireRunRecord` under a client-facing name — the inverse of the server's encode, so the field set cannot drift.
 */
const nodeFromRecord = fromWireRunRecord;

/** The immutable snapshot a view renders. Every mutating call produces a fresh object. */
export interface RunViewState {
  rootRunId: string;
  /** Mirrors the root run's status (the run whose id is `rootRunId`). */
  status: RunStatus;
  output: JsonValue | null;
  /** What the tree was launched with (ADR 0046), decoded to the domain shape. A per-tree fact, so it
   * sits on the snapshot; absent when the launch supplied nothing beyond the workflow file. */
  launchFacts?: LaunchFacts;
  /** Every run in the tree, keyed by `runId`. */
  runs: ReadonlyMap<string, RunNodeState>;
  /** The complete chronological narrative, ordered by `seq` (the ordering truth), deduped. */
  narrative: readonly LogEvent[];
  /** Liveness of the event stream feeding `narrative`. */
  stream: StreamPhase;
  /** The status each run should display — `displayStatusByRun` owns the rule (view-only, ADR 0038).
   * A run the map lacks falls back to its record status. */
  displayStatus: ReadonlyMap<string, RunStatus>;
  /** The last failure message each run reached, keyed by run id. The error text rides the
   * `step-finished` event, not the run record (mvp spec §8.1), so it is folded here. */
  lastError: ReadonlyMap<string, string>;
  /** The runs parked `awaiting` in this tree, for a surface that counts or badges them (ADR 0042). */
  awaitingRunIds: ReadonlySet<string>;
}

/** The derived facts a run surface reads off the snapshot, without reaching past the view. */
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
      // A tree read races the run it describes: rows win on structure (the only source of parentage),
      // but never walk a finished run backwards.
      const existing = this.runs.get(row.run_id);
      if (existing && isTerminal(existing.status) && !isTerminal(node.status)) {
        node.status = existing.status;
        node.finishedAt ??= existing.finishedAt;
      }
      this.runs.set(row.run_id, node);
    }
    this.output = tree.output;
    // Decoded through the shared inverse; left absent (not `{}`) when the response has no `launch_facts`.
    this.launchFacts =
      tree.launch_facts !== undefined ? fromWireLaunchFacts(tree.launch_facts) : undefined;
    const root = this.runs.get(this.rootRunId);
    this.rootStatus = root?.status ?? tree.status;
    this.commit();
  }

  /** Record the stream's liveness; a no-op when the phase is unchanged, so subscribers do not re-render. */
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
    if (event.type === "pass-started") this.numberPass(event);
    this.commit();
  }

  /** Stamp a pass container's ordinal from the `pass-started` that follows it (ADR 0054): the newest
   * un-numbered run under that workflow-run named by the same opener. A numbered tree row wins. */
  private numberPass(event: Extract<LogEvent, { type: "pass-started" }>): void {
    let container: RunNodeState | undefined;
    for (const run of this.runs.values()) {
      if (run.runId === event.run_id || run.runId === this.rootRunId) continue;
      if (run.nodeId !== event.node_id || run.pass !== null || run.iteration !== null) continue;
      if (run.parentRunId !== null && run.parentRunId !== event.run_id) continue;
      container = run;
    }
    if (container) container.pass = event.pass;
  }

  private applyToRun(event: LogEvent): void {
    const existing = this.runs.get(event.run_id);
    // An event can name a run before its row arrives (parentage comes from the row): start it blank.
    const node: RunNodeState =
      existing ??
      blankRunRecord({
        runId: event.run_id,
        rootRunId: this.rootRunId,
        nodeId: event.node_id,
        nodeName: event.node_name,
      });

    // Status transitions — including the replay guards — live in `runStatusAfter`, their one owner.
    node.status = runStatusAfter(node.status, event);
    if (event.type === "step-started") {
      node.workerName = event.worker_name;
      node.startedAt ??= event.ts;
    } else if (event.type === "step-finished") {
      node.finishedAt = event.ts;
      // The error text rides the event, not the run row (mvp spec §8.1); the last one for a run wins.
      if (event.error !== undefined) this.lastErrorById.set(event.run_id, event.error);
    }

    this.runs.set(node.runId, node);
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
