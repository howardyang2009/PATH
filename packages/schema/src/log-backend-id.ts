/**
 * The engine-level `log.backends` operator setting (mvp spec §8.2, server-api-v0.md §2
 * `log_backends`): which log backends a run fans out to. This is engine configuration, *not*
 * workflow-file content. Both are on by default.
 *
 * Owned here rather than in `@path/engine` because `@path/client-core` names this on its public
 * `startRun` surface and carries no engine dependency by design (ADR 0013). Engine re-exports the
 * tuple and type from here, so the runtime source of truth is this single `as const` declaration —
 * a new backend id added here reaches both the engine that instantiates it and the wire/client
 * surface that names it.
 */
export const LOG_BACKEND_IDS = ["db", "ndjson"] as const;
export type LogBackendId = (typeof LOG_BACKEND_IDS)[number];
