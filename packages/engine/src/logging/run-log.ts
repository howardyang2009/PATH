import type { LogEvent } from "@path/schema";
import type Database from "better-sqlite3";
import { getLogEventsForRoot, maxLogSeqForRoot } from "./db-backend.js";
import { readNdjsonLog } from "./ndjson-backend.js";

// One root run's **narrative**, read back. **Emptiness, not existence, is the switch**: a header-only
// `run.log` has no narrative, so the table answers instead.
export interface RunLog {
  /** Every recorded event, in `seq` order — already masked at write, so no second pass here. */
  events(): LogEvent[];
  /** The events after `afterSeq` — what an SSE replay asks for. */
  read(afterSeq: number): LogEvent[];
  /** The highest recorded `seq`, or `0` — where a Complete re-invocation continues from (ADR 0041). */
  lastSeq(): number;
}

export function openRunLog(projectDir: string, db: Database.Database, rootRunId: string): RunLog {
  // `run.log` first, `log_events` second; §5.2 uses the on-disk file as the stream's yardstick.
  const events = (): LogEvent[] => {
    const ndjson = readNdjsonLog(projectDir, rootRunId);
    return ndjson.length > 0 ? ndjson : getLogEventsForRoot(db, rootRunId);
  };

  return {
    events,
    read: (afterSeq) => events().filter((event) => event.seq > afterSeq),
    lastSeq: () =>
      Math.max(
        maxLogSeqForRoot(db, rootRunId),
        events().reduce((max, event) => Math.max(max, event.seq), 0),
      ),
  };
}
