import type Database from "better-sqlite3";
import type { LogBackend } from "./log-backend.js";
import { insertLogEvent } from "./log-store.js";

/**
 * The db log backend (mvp spec §8.2): one row per event in the `log_events` table, stamped with the
 * root run id captured from `open()`. Shares the project's `Database` handle with run-row
 * persistence (better-sqlite3 is synchronous, single-connection), so the async seam here resolves
 * synchronously.
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
      insertLogEvent(db, rootRunId, event);
    },
    async close() {
      // The shared db handle is owned and closed by the caller (cli.ts) — nothing to flush here.
    },
  };
}
