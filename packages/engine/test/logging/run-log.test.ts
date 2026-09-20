import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogEvent } from "@path/schema";
import { createDbLogBackend, maxLogSeqForRoot } from "../../src/logging/db-backend.js";
import { createNdjsonBackend } from "../../src/logging/ndjson-backend.js";
import { LOG_FORMAT } from "../../src/logging/log-backend.js";
import { openRunLog } from "../../src/logging/run-log.js";
import { openDb } from "../../src/persistence/db.js";

/**
 * One root run's narrative, read across both stores (#architecture-deepening): the archive's replay and
 * a Complete's continuation point now read the same rule, because they read the same module. These drive
 * the two backends for real, so "which store answers" is exercised over actual files and rows.
 */

const ROOT = "root-1";

let projectDir: string;
let db: Database.Database;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-engine-run-log-test-"));
  db = openDb(join(projectDir, "path.db"));
});

afterEach(() => {
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function event(seq: number): LogEvent {
  // A real `step-started` envelope — the backends validate every line on write and read.
  return {
    type: "step-started",
    seq,
    ts: "2026-07-27T10:00:00.000Z",
    run_id: `${ROOT}-${seq}`,
    node_id: null,
    node_name: null,
    step_type: "binary",
    worker_name: "spawn",
  };
}

async function writeEvents(backend: ReturnType<typeof createNdjsonBackend> | ReturnType<typeof createDbLogBackend>, seqs: number[], append = false): Promise<void> {
  await backend.open({ runId: ROOT, format: LOG_FORMAT, append });
  for (const seq of seqs) await backend.write(event(seq));
  await backend.close();
}

describe("openRunLog", () => {
  it("answers from the NDJSON stream when it has a narrative", async () => {
    await writeEvents(createNdjsonBackend(projectDir), [1, 2, 3]);

    const log = openRunLog(projectDir, db, ROOT);

    expect(log.events().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.read(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(log.lastSeq()).toBe(3);
  });

  it("falls back to the table when the run's stream is empty", async () => {
    await writeEvents(createDbLogBackend(db), [1, 2]);
    // A `run.log` with only its header line is no narrative at all, so the table answers.
    await writeEvents(createNdjsonBackend(projectDir), []);

    const log = openRunLog(projectDir, db, ROOT);

    expect(log.events().map((e) => e.seq)).toEqual([1, 2]);
    expect(log.lastSeq()).toBe(2);
  });

  it("takes lastSeq as the max over both stores, so neither is authoritative", async () => {
    await writeEvents(createDbLogBackend(db), [1, 2, 3, 4]);
    await writeEvents(createNdjsonBackend(projectDir), [1, 2, 3, 4, 5, 6]);

    // The table is behind the file — the continuation point is the file's, not the table's.
    expect(maxLogSeqForRoot(db, ROOT)).toBe(4);
    expect(openRunLog(projectDir, db, ROOT).lastSeq()).toBe(6);
  });

  it("is empty and at seq 0 for a run with neither backend", () => {
    const log = openRunLog(projectDir, db, ROOT);

    expect(log.events()).toEqual([]);
    expect(log.lastSeq()).toBe(0);
  });
});
