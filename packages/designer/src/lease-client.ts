import type { AcquireLockResult, HeartbeatResult, PathApiClient } from "@path/client-core";

/**
 * The client half of the Designer edit-lock lease (#371, ADR 0017). The server owns the lease as an
 * on-disk marker; this controller is the browser side that keeps one **alive per open file** — acquire
 * on open (before the first keystroke), heartbeat every 10s, release on close — and surfaces the two
 * conflict outcomes the UI must act on: an acquire `409` (someone else is editing: count down, offer a
 * confirmation-gated takeover) and a heartbeat `409` (the lease was reclaimed or taken over: stop
 * beating, warn, offer re-acquire).
 *
 * It is framework-free and driven by an injected `PathApiClient` and scheduler, so React is a thin
 * subscriber over it (`use-edit-leases.ts`) and the state machine is unit-tested without a DOM. One
 * controller holds several leases at once under one `session_id`: a `workflow`-ref descent opens a
 * second file, and each file's marker beats independently (ADR 0017). A brand-new, never-saved workflow
 * has no path and so is simply never reconciled in — no path, no lease.
 */

/** Heartbeat cadence: 10s, so a live tab beats three times per the server's 30s TTL (ADR 0017). */
export const HEARTBEAT_MS = 10_000;

/** The per-file lease state the UI renders. */
export type LeaseState =
  | { phase: "acquiring" }
  /** Held by us; `expiresAt` is the server's wall-clock expiry, renewed each beat. */
  | { phase: "held"; expiresAt: string }
  /** A live marker under another session (acquire `409`); `expiresAt` drives the takeover countdown. */
  | { phase: "held-by-other"; expiresAt: string | null }
  /** The lease was lost mid-edit (heartbeat `409`): reclaimed after expiry, or taken over. */
  | { phase: "lost" }
  /** The acquire failed for a non-`409` reason (a `404` escape, a network error). */
  | { phase: "error"; message: string };

export type LeaseMap = ReadonlyMap<string, LeaseState>;

/** A cancellable repeating timer, injected so tests drive the heartbeat by hand. */
export interface LeaseScheduler {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

/** The lock surface the controller needs — the three ADR 0017 routes, nothing else. */
type LockClient = Pick<PathApiClient, "acquireLock" | "heartbeatLock" | "releaseLock">;

interface Entry {
  state: LeaseState;
  /** Bumped on every acquire/reacquire/takeover/stop, so a stale async reply for this path is dropped. */
  epoch: number;
  timer: unknown | null;
}

const defaultScheduler: LeaseScheduler = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class LeaseController {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(map: LeaseMap) => void>();
  private readonly heartbeatMs: number;

  constructor(
    private readonly client: LockClient,
    readonly sessionId: string,
    private readonly scheduler: LeaseScheduler = defaultScheduler,
    heartbeatMs: number = HEARTBEAT_MS,
  ) {
    this.heartbeatMs = heartbeatMs;
  }

  /** The current per-path lease snapshot. */
  snapshot(): LeaseMap {
    return new Map([...this.entries].map(([path, entry]) => [path, entry.state]));
  }

  /** Subscribe to state changes; the callback fires on every transition. Returns an unsubscribe. */
  subscribe(listener: (map: LeaseMap) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reconcile the held leases against the set of open file paths (the navigation stack). A path that is
   * newly open acquires; a path that is no longer open releases. Called on every stack change, so a
   * descent acquires the child's lease and an ascend releases it. Idempotent for an unchanged set.
   */
  reconcile(paths: readonly string[]): void {
    const wanted = new Set(paths);
    for (const path of [...this.entries.keys()]) {
      if (!wanted.has(path)) this.drop(path);
    }
    for (const path of wanted) {
      if (!this.entries.has(path)) {
        this.entries.set(path, { state: { phase: "acquiring" }, epoch: 0, timer: null });
        void this.acquire(path, false);
      }
    }
    this.emit();
  }

  /** Take over a lease held by another session — the explicit, confirmation-gated `takeover: true`. */
  takeover(path: string): void {
    if (this.entries.has(path)) void this.acquire(path, true);
  }

  /** Re-acquire after a lost lease (a heartbeat `409`) — the "editing lease lost" re-acquire affordance. */
  reacquire(path: string): void {
    if (this.entries.has(path)) void this.acquire(path, false);
  }

  /** The paths currently held by us — the set a `beforeunload` beacon must release. */
  heldPaths(): string[] {
    return [...this.entries]
      .filter(([, entry]) => entry.state.phase === "held")
      .map(([path]) => path);
  }

  /** Stop every heartbeat and drop every entry (an in-app close of the whole session). */
  dispose(): void {
    for (const path of [...this.entries.keys()]) this.drop(path);
    this.entries.clear();
    this.emit();
  }

  /** Acquire (or take over) one path, guarded by an epoch so a stale reply cannot overwrite a newer state. */
  private async acquire(path: string, takeover: boolean): Promise<void> {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.stopTimer(entry);
    const epoch = ++entry.epoch;
    entry.state = { phase: "acquiring" };
    this.emit();

    let result: AcquireLockResult;
    try {
      result = await this.client.acquireLock({
        workflowPath: path,
        sessionId: this.sessionId,
        ...(takeover ? { takeover: true } : {}),
      });
    } catch (error) {
      this.settle(path, epoch, { phase: "error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (result.status === "granted") {
      this.settle(path, epoch, { phase: "held", expiresAt: result.lease.expires_at }, /* beat */ true);
    } else {
      this.settle(path, epoch, { phase: "held-by-other", expiresAt: result.expiresAt });
    }
  }

  /** Apply a settled acquire result if the epoch still matches, optionally starting the heartbeat. */
  private settle(path: string, epoch: number, state: LeaseState, beat = false): void {
    const entry = this.entries.get(path);
    if (!entry || entry.epoch !== epoch) return;
    entry.state = state;
    if (beat) this.startTimer(path, entry);
    this.emit();
  }

  private startTimer(path: string, entry: Entry): void {
    this.stopTimer(entry);
    entry.timer = this.scheduler.setInterval(() => void this.beat(path), this.heartbeatMs);
  }

  /** One heartbeat, epoch-guarded like `acquire`: a `lost` stops the beat and flips the UI to re-acquire. */
  private async beat(path: string): Promise<void> {
    const entry = this.entries.get(path);
    if (!entry || entry.state.phase !== "held") return;
    const epoch = entry.epoch;

    let result: HeartbeatResult;
    try {
      result = await this.client.heartbeatLock({ workflowPath: path, sessionId: this.sessionId });
    } catch {
      // A transient network error is not a lost lease — the marker is still ours on the server until
      // the TTL. Skip this beat; the next one recovers if the network does.
      return;
    }
    const current = this.entries.get(path);
    if (!current || current.epoch !== epoch) return;
    if (result.status === "renewed") {
      current.state = { phase: "held", expiresAt: result.lease.expires_at };
    } else {
      this.stopTimer(current);
      current.state = { phase: "lost" };
    }
    this.emit();
  }

  /** Release one path's lease (fire-and-forget) and forget it — the reconcile-away and dispose path. */
  private drop(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.stopTimer(entry);
    entry.epoch++; // invalidate any in-flight acquire/beat for this path
    // Release only a lease we actually hold; a held-by-other or errored path never took the marker.
    if (entry.state.phase === "held") {
      void this.client.releaseLock({ workflowPath: path, sessionId: this.sessionId }).catch(() => {});
    }
    this.entries.delete(path);
  }

  private stopTimer(entry: Entry): void {
    if (entry.timer !== null) {
      this.scheduler.clearInterval(entry.timer);
      entry.timer = null;
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }
}
