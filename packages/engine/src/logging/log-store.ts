import type Database from "better-sqlite3";
import { type LogEvent, LogEventSchema } from "@path/schema";

/**
 * The db log backend's table access (mvp spec §8.2). Envelope columns are denormalized for
 * queryability; the whole event is stored as JSON in `event` so a read round-trips back through
 * `LogEventSchema`. `seq` is monotonic per root run, so the (root_run_id, seq) primary key doubles
 * as the ordering key.
 */
export function insertLogEvent(db: Database.Database, rootRunId: string, event: LogEvent): void {
  db.prepare(
    `INSERT INTO log_events (root_run_id, seq, ts, type, run_id, node_id, event)
     VALUES (@rootRunId, @seq, @ts, @type, @runId, @nodeId, @event)`,
  ).run({
    rootRunId,
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    runId: event.run_id,
    nodeId: event.node_id,
    event: JSON.stringify(event),
  });
}

/** Reads one root run's narrative back in `seq` order, revalidating each stored event. */
export function getLogEventsForRoot(db: Database.Database, rootRunId: string): LogEvent[] {
  const rows = db
    .prepare(`SELECT event FROM log_events WHERE root_run_id = @rootRunId ORDER BY seq`)
    .all({ rootRunId }) as { event: string }[];
  return rows.map((row) => LogEventSchema.parse(JSON.parse(row.event)));
}
