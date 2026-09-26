import { type LogEvent, LogEventSchema, type ReuseMarkerEvent } from "@path/schema";
import type Database from "better-sqlite3";
import type { LogBackend } from "./log-backend.js";

/**
 * The db log backend (mvp spec §8.2): one row per event in `log_events`, stamped with the root run id
 * captured from `open()`. Shares the project's synchronous, single-connection `Database` handle.
 *
 * The SQL lives here so `write` is the only way a row reaches `log_events`: the engine assembles the
 * envelope, `seq` and masking before the seam, and an insert around the sink could carry an event none
 * of that was applied to. Envelope columns are denormalized; the whole event is also stored as JSON so
 * a read round-trips through `LogEventSchema`.
 */
export function createDbLogBackend(db: Database.Database): LogBackend {
  let rootRunId: string | null = null;

  return {
    async open({ runId }) {
      rootRunId = runId;
    },
    async write(event) {
      if (rootRunId === null) {
        throw new Error(
          "db log backend: write before open — no root run id to scope the event under",
        );
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
      // The shared db handle is owned and closed by the caller — nothing to flush here.
    },
  };
}

// Where a Complete re-invocation continues the per-root `seq` from (ADR 0041).
export function maxLogSeqForRoot(db: Database.Database, rootRunId: string): number {
  const row = db
    .prepare(`SELECT MAX(seq) AS maxSeq FROM log_events WHERE root_run_id = @rootRunId`)
    .get({ rootRunId }) as {
    maxSeq: number | null;
  };
  return row.maxSeq ?? 0;
}

// Reads one root run's narrative back in `seq` order, revalidating each stored event. The fallback when
// a run has no `run.log` to replay; events were masked before `write`, so what comes back is masked.
export function getLogEventsForRoot(db: Database.Database, rootRunId: string): LogEvent[] {
  const rows = db
    .prepare(`SELECT event FROM log_events WHERE root_run_id = @rootRunId ORDER BY seq`)
    .all({ rootRunId }) as { event: string }[];
  return rows.map((row) => LogEventSchema.parse(JSON.parse(row.event)));
}

// One reuse-marker as the `rm` guard reads it: which successor root run holds it, and which run in the
// *original* tree its data lives in — what `runs rm` resolves to see if a live successor still needs it.
export function reuseMarkerReferences(
  db: Database.Database,
): { holderRootRunId: string; originalRunId: string }[] {
  const rows = db
    .prepare(`SELECT root_run_id, event FROM log_events WHERE type = 'reuse-marker'`)
    .all() as { root_run_id: string; event: string }[];
  return rows.map((row) => {
    const event = LogEventSchema.parse(JSON.parse(row.event)) as ReuseMarkerEvent;
    return { holderRootRunId: row.root_run_id, originalRunId: event.original_run_id };
  });
}
