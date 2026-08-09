import { type LogEvent, LogEventSchema, type ReuseMarkerEvent } from "@path/schema";
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
        `INSERT INTO log_events (root_run_id, seq, ts, type, run_id, node_id, node_name, event)
         VALUES (@rootRunId, @seq, @ts, @type, @runId, @nodeId, @nodeName, @event)`,
      ).run({
        rootRunId,
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        runId: event.run_id,
        nodeId: event.node_id,
        nodeName: event.node_name,
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
 * `RunArchive.events()` reaches for this when a run has no `run.log` to replay — the ndjson backend
 * was off — so the table is both the audit record §8.2 rests on and the second source SSE replay
 * can be served from. Events were masked before reaching `write`, so what comes back is masked.
 */
export function getLogEventsForRoot(db: Database.Database, rootRunId: string): LogEvent[] {
  const rows = db
    .prepare(`SELECT event FROM log_events WHERE root_run_id = @rootRunId ORDER BY seq`)
    .all({ rootRunId }) as { event: string }[];
  return rows.map((row) => LogEventSchema.parse(JSON.parse(row.event)));
}

/** One reuse-marker as the `rm` guard reads it (#175): which root run holds it, and which run in the
 * *original* tree its data lives in. `holderRootRunId` is the marker's own `root_run_id` column — the
 * successor tree that reused the node — and `originalRunId` its `original_run_id` payload, the run the
 * marker back-references. `runs rm` resolves the latter against the tree it is about to delete to know
 * whether a live successor still depends on that tree's data. Project-wide: the `type` column is
 * denormalized precisely so this scan need not open every tree's log. */
export function reuseMarkerReferences(db: Database.Database): { holderRootRunId: string; originalRunId: string }[] {
  const rows = db
    .prepare(`SELECT root_run_id, event FROM log_events WHERE type = 'reuse-marker'`)
    .all() as { root_run_id: string; event: string }[];
  return rows.map((row) => {
    const event = LogEventSchema.parse(JSON.parse(row.event)) as ReuseMarkerEvent;
    return { holderRootRunId: row.root_run_id, originalRunId: event.original_run_id };
  });
}
