import type Database from "better-sqlite3";
import { createDbLogBackend } from "./db-backend.js";
import type { LogBackend } from "./log-backend.js";
import { createNdjsonBackend } from "./ndjson-backend.js";

/**
 * The engine-level `log.backends` operator setting (mvp spec §8.2): which log backends a run fans
 * out to. This is engine configuration, *not* workflow-file content. Both are on by default.
 */
export const LOG_BACKEND_IDS = ["db", "ndjson"] as const;
export type LogBackendId = (typeof LOG_BACKEND_IDS)[number];
export const DEFAULT_LOG_BACKENDS: readonly LogBackendId[] = LOG_BACKEND_IDS;

export function isLogBackendId(value: string): value is LogBackendId {
  return (LOG_BACKEND_IDS as readonly string[]).includes(value);
}

/** Instantiates the selected backends per root run — the db table and/or the NDJSON `run.log`. */
export function createLogBackends(
  ids: readonly LogBackendId[],
  deps: { db: Database.Database; projectDir: string },
): LogBackend[] {
  return ids.map((id) => (id === "db" ? createDbLogBackend(deps.db) : createNdjsonBackend(deps.projectDir)));
}
