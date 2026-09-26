import type { LogBackend } from "@path/engine";
import type { RunEventHub } from "./run-event-hub.js";

/** A live-forwarding `LogBackend` (server-api-v0.md §5): a third backend beside the persisted db/NDJSON
 * ones, pushing each already-masked `LogEvent` into its root run's hub so SSE clients see events without
 * polling. Nothing here may throw — a backend write failure would fail the run (mvp spec §8.2). */
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
