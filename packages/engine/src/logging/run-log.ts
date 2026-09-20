import type Database from "better-sqlite3";
import type { LogEvent } from "@path/schema";
import { getLogEventsForRoot, maxLogSeqForRoot } from "./db-backend.js";
import { readNdjsonLog } from "./ndjson-backend.js";

/**
 * One root run's **narrative**, read back — the one owner of "where did this run's events go, and how
 * far does it reach".
 *
 * **What this module exists to own.** A root run's narrative lives in `run.log` (the NDJSON backend)
 * and/or the `log_events` table (the db backend), and which of the two answers is a per-run fact of
 * configuration (mvp spec §8.2's default is both). Three modules used to re-derive it: the archive's
 * `events()` picked by emptiness, a Complete re-invocation took a `max` over both because neither is
 * authoritative for the continuation point, and the logging observer opened and closed the streams
 * itself. The read rule is one rule, so it lives here — {@link openRunLog} — with both backends staying
 * the dumb sinks they are.
 *
 * **Emptiness, not existence, is the switch** (the archive's own long-standing rule): a `run.log` that
 * is still just its header has no narrative, so the table answers instead, and a run with neither
 * backend enabled finds both empty and is genuinely empty.
 */
export interface RunLog {
  /** Every recorded event, in `seq` order — already masked at write, so no second pass here. */
  events(): LogEvent[];
  /** The events after `afterSeq` — what an SSE replay asks for. */
  read(afterSeq: number): LogEvent[];
  /**
   * The highest recorded `seq`, or `0` when nothing was recorded — the point a Complete
   * re-invocation continues from (ADR 0041), taken as a `max` over both stores so it is correct
   * whichever backend the launch used.
   */
  lastSeq(): number;
}

export function openRunLog(projectDir: string, db: Database.Database, rootRunId: string): RunLog {
  // `run.log` first, `log_events` second. With both backends on, the two hold the same narrative, so
  // reading the file keeps every replay in the default configuration byte-identical to what it was
  // before the table became readable — including acceptance §5.2, which uses `run.log` on disk as the
  // yardstick the stream must match. The fallback is reached exactly when the ndjson backend was off.
  const events = (): LogEvent[] => {
    const ndjson = readNdjsonLog(projectDir, rootRunId);
    return ndjson.length > 0 ? ndjson : getLogEventsForRoot(db, rootRunId);
  };

  return {
    events,
    read: (afterSeq) => events().filter((event) => event.seq > afterSeq),
    lastSeq: () => Math.max(maxLogSeqForRoot(db, rootRunId), events().reduce((max, event) => Math.max(max, event.seq), 0)),
  };
}
