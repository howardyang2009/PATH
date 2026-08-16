import { LOG_BACKEND_IDS, type LogBackendId } from "@path/schema";
import type Database from "better-sqlite3";
import { createDbLogBackend } from "./db-backend.js";
import type { LogBackend } from "./log-backend.js";
import { createNdjsonBackend } from "./ndjson-backend.js";

// `LOG_BACKEND_IDS` / `LogBackendId` are owned by `@path/schema` (ADR 0013) so `@path/client-core`
// can name the enum without an engine dependency. Engine re-exports them here, keeping every
// existing consumer's import (`./logging/backends.js`) and `createLogBackends` unchanged.
export { LOG_BACKEND_IDS, type LogBackendId };
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
