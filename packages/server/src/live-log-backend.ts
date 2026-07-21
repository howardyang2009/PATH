import type { LogBackend } from "@path/engine";
import type { RunEventHub } from "./run-event-hub.js";

/**
 * A live-forwarding `LogBackend` (server-api-v0.md §5): a dumb third backend, attached alongside the
 * run's persisted db/NDJSON backends, that pushes each fully-formed, already-masked `LogEvent` into
 * the `RunEventHub` for its root run so connected SSE clients see events as `runWorkflow` executes —
 * no polling of the db/NDJSON file for live events.
 *
 * Every method is fail-safe: a backend write failure would fail the run (mvp spec §8.2), but nothing
 * here can throw, so an SSE consumer never disrupts execution. `open` carries the root run id — a
 * backend is instantiated per root run, so `runId` here is always the root.
 */
export function createLiveLogBackend(hub: RunEventHub): LogBackend {
  let rootRunId: string | undefined;
  return {
    async open({ runId }) {
      rootRunId = runId;
      hub.open(runId);
    },
    async write(event) {
      if (rootRunId !== undefined) hub.publish(rootRunId, event);
    },
    async close() {
      if (rootRunId !== undefined) hub.close(rootRunId);
    },
  };
}
