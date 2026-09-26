/** The engine-level `log.backends` operator setting (mvp spec §8.2): engine configuration, not
 * workflow-file content. Owned here so `@path/client-core` can name it without an engine dependency. */
export const LOG_BACKEND_IDS = ["db", "ndjson"] as const;
export type LogBackendId = (typeof LOG_BACKEND_IDS)[number];
