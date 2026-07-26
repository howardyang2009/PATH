/**
 * The set of root runs this server process is currently executing, each holding the
 * `AbortController` whose signal was handed to `runWorkflow` — what makes
 * `POST /v0/runs/:root_run_id/cancel` (server-api-v0.md §4.2) possible at all. Runs execute
 * in-process (spec §2), so cancelling one is a matter of keeping its controller reachable by
 * `root_run_id`.
 *
 * Membership is the server's honest answer to "can I actually stop this run?": a `running` row with
 * no entry here belongs to some other process — a `path run` writing to the same `.path/path.db`, or
 * a run left behind by an earlier crashed server — and the route must refuse rather than promise a
 * cancel it cannot perform. So entries are registered only once `runStarted` has produced the
 * `root_run_id`, and dropped on every outcome (`post-runs.ts`) so a long-lived server accumulates
 * nothing.
 *
 * Deliberately not exported from `index.ts`, unlike `RunEventHub`: clients cancel through the route,
 * not by reaching for this, so it stays an implementation detail the package can reshape freely.
 */
export class RunControllers {
  private readonly controllers = new Map<string, AbortController>();

  /** A root run started in this process — its id now exists, so its controller becomes reachable. */
  register(rootRunId: string, controller: AbortController): void {
    this.controllers.set(rootRunId, controller);
  }

  /**
   * Signals the run's abort, best-effort (mvp spec §5.6). `false` means no run by that id is
   * executing here — the caller must not report a cancel. Aborting an already-aborted run is a
   * no-op that still answers `true`, which is what makes a repeated cancel safe.
   */
  abort(rootRunId: string): boolean {
    const controller = this.controllers.get(rootRunId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** The run reached a terminal status (or crashed) — it is no longer cancellable. */
  delete(rootRunId: string): void {
    this.controllers.delete(rootRunId);
  }

  /** How many runs are currently cancellable here; 0 once every started run has settled. */
  get size(): number {
    return this.controllers.size;
  }
}
