import { type LogEvent, LogEventSchema } from "@path/schema";
import type Database from "better-sqlite3";
import type { LogBackend } from "./log-backend.js";

/**
 * The db log backend (mvp spec §8.2): one row per event in the `log_events` table, stamped with the
 * root run id captured from `open()`. Shares the project's `Database` handle with run-row
 * persistence (better-sqlite3 is synchronous, single-connection), so the async seam here resolves
 * synchronously.
 *
 * The SQL lives here rather than in a store of its own, so that `write` is the only way a row
 * reaches `log_events`. That is what the §8.2 failure policy rests on: the engine assembles the
 * envelope, the `seq` and the masking before the seam, and a backend is a dumb sink — an insert
 * reachable around the sink could carry an event none of that had been applied to.
 *
 * Envelope columns are denormalized for queryability; the whole event is stored as JSON in `event`
 * so a read round-trips back through `LogEventSchema`. `seq` is monotonic per root run, so the
 * (root_run_id, seq) primary key doubles as the ordering key.
 */
export function createDbLogBackend(db: Database.Database): LogBackend {
  let rootRunId: string | null = null;

  return {
    async open({ runId }) {
      rootRunId = runId;
    },
    async write(event) {
      if (rootRunId === null) {
        throw new Error("db log backend: write before open — no root run id to scope the event under");
      }
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
    },
    async close() {
      // The shared db handle is owned and closed by the caller (cli.ts) — nothing to flush here.
    },
  };
}

/**
 * Reads one root run's narrative back in `seq` order, revalidating each stored event.
 *
 * The product reads a narrative from the NDJSON file (`readNdjsonLog`), not from here — this is how
 * the table itself is read back, which is what makes it an audit record rather than a write-only
 * side effect (§8.2).
 */
export function getLogEventsForRoot(db: Database.Database, rootRunId: string): LogEvent[] {
  const rows = db
    .prepare(`SELECT event FROM log_events WHERE root_run_id = @rootRunId ORDER BY seq`)
    .all({ rootRunId }) as { event: string }[];
  return rows.map((row) => LogEventSchema.parse(JSON.parse(row.event)));
}
