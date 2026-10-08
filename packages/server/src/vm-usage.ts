import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

// VM time per user (docs/spec/path-website.md §8): a host-level table, beside the creator table,
// of each VM's start and end. A user's usage is their VM time in the last 24 h.

export const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface VmUsage {
  /** Start the clock on one VM of `userId`; the returned function stops it and is idempotent. */
  begin(userId: string): () => void;
  /** The user's VM time in the last 24 h, a running VM counting up to now. */
  usedMs(userId: string): number;
  /** When the user's usage drops under `budgetMs`, or `undefined` while it is under now. A running
   * VM is taken to end now. Never, for a budget of 0. */
  retryAt(userId: string, budgetMs: number): number | undefined;
  close(): void;
}

interface Span {
  started_at: number;
  ended_at: number | null;
}

/** Opens (creating if absent) the usage table at `dbPath`. A VM a previous process left open ends
 * at this open, when the reaper removes it, or at `maxVmMs` past its start if that is sooner. */
export function openVmUsage(
  dbPath: string,
  now: () => number = Date.now,
  maxVmMs = 60 * 60 * 1000,
): VmUsage {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS vm_usage (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS vm_usage_user ON vm_usage (user_id);
  `);
  db.prepare("UPDATE vm_usage SET ended_at = MIN(?, started_at + ?) WHERE ended_at IS NULL").run(
    now(),
    maxVmMs,
  );
  db.prepare("DELETE FROM vm_usage WHERE ended_at < ?").run(now() - USAGE_WINDOW_MS);

  const insert = db.prepare<[string, number]>(
    "INSERT INTO vm_usage (user_id, started_at) VALUES (?, ?)",
  );
  const finish = db.prepare<[number, number | bigint]>(
    "UPDATE vm_usage SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
  );
  const spans = db.prepare<[string, number], Span>(
    "SELECT started_at, ended_at FROM vm_usage WHERE user_id = ? AND (ended_at IS NULL OR ended_at > ?)",
  );

  /** The usage in the window ending at `windowEnd` (not before `nowMs`), open spans ending now. */
  const usageAt = (rows: Span[], windowEnd: number, nowMs: number): number =>
    rows.reduce(
      (sum, row) =>
        sum +
        Math.max(
          0,
          (row.ended_at ?? nowMs) - Math.max(row.started_at, windowEnd - USAGE_WINDOW_MS),
        ),
      0,
    );

  return {
    begin(userId) {
      const id = insert.run(userId, now()).lastInsertRowid;
      return () => void finish.run(now(), id);
    },
    usedMs(userId) {
      const t = now();
      return usageAt(spans.all(userId, t - USAGE_WINDOW_MS), t, t);
    },
    retryAt(userId, budgetMs) {
      const t = now();
      const rows = spans.all(userId, t - USAGE_WINDOW_MS);
      if (usageAt(rows, t, t) < budgetMs) return undefined;
      if (budgetMs <= 0) return Number.POSITIVE_INFINITY;
      // Usage only falls as the window slides, and is 0 a full window from now.
      let lo = t;
      let hi = t + USAGE_WINDOW_MS;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (usageAt(rows, mid, t) < budgetMs) hi = mid;
        else lo = mid;
      }
      return Math.ceil(hi / 1000) * 1000;
    },
    close: () => db.close(),
  };
}
