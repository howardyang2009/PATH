import { LOG_BACKEND_IDS, type LogBackendId } from "@path/schema";
import type Database from "better-sqlite3";
import { createDbLogBackend } from "./db-backend.js";
import type { LogBackend } from "./log-backend.js";
import { createNdjsonBackend } from "./ndjson-backend.js";

// Owned by `@path/schema` (ADR 0013) so `@path/client-core` can name the enum without an engine
// dependency; re-exported here for existing importers of `./logging/backends.js`.
export { LOG_BACKEND_IDS, type LogBackendId };
export const DEFAULT_LOG_BACKENDS: readonly LogBackendId[] = LOG_BACKEND_IDS;

export function isLogBackendId(value: string): value is LogBackendId {
  return (LOG_BACKEND_IDS as readonly string[]).includes(value);
}

// Instantiates the selected backends per root run — the db table and/or the NDJSON `run.log`.
export function createLogBackends(
  ids: readonly LogBackendId[],
  deps: { db: Database.Database; projectDir: string },
): LogBackend[] {
  return ids.map((id) =>
    id === "db" ? createDbLogBackend(deps.db) : createNdjsonBackend(deps.projectDir),
  );
}
