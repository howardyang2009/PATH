export { loadWorkflowTree, type WorkflowTree, type LoadResult } from "./load-workflow-tree.js";
export { runWorkflow, type ResumeInput, type RunOptions, type RunResult } from "./run-workflow.js";
export { openProject, type OpenProjectResult, type Project, type ProjectRunOptions } from "./project.js";
export { type ListRootsOptions, type RunArchive, type RunBlobName, type RunTree } from "./run-archive.js";
export { type Observation, ObserverError, type RunObserver, type RunOutcome } from "./run-observer.js";
export { LOG_FORMAT, type LogBackend, type LogFormat } from "./logging/log-backend.js";
export { readNdjsonLog } from "./logging/ndjson-backend.js";
export { LOG_BACKEND_IDS, type LogBackendId } from "./logging/backends.js";
export type { LlmWorker, PromptRequest, PromptResult } from "./llm/llm-worker.js";
export { openDb, SchemaVersionError } from "./persistence/db.js";
export { dbFilePath, pathDir, rootRunTreeDir } from "./persistence/paths.js";

// What a consumer may name is what it needs to *use* the engine, not what the engine is built from.
// Two rules decide this list:
//
// - **Assembly is not exported.** `openProject` composes the observers, the log backends, the run
//   archive and `.path/` itself; `runWorkflow` builds the LLM worker, the processor semaphore and
//   the secret masker. Exporting their ingredients — `composeObservers`, `createLoggingObserver`,
//   `createPersistedObserver`, `createLogBackends`, `createRunArchive`, `ensurePathDirGitignore`,
//   `createAgentSdkWorker`, `createProcessorSemaphore`, `collectSecrets` — let a consumer rebuild
//   that composition by hand, in the wrong order, which is the hazard having an owner removed.
//   `main` is likewise not here: `bin/path.ts` imports it from `./cli.js`, the only caller there is.
//
// - **A seam's vocabulary stays, even when its default adapter goes.** `RunOptions.observer`,
//   `RunOptions.llmWorker` and `LogBackend` are substitution points, so `RunObserver`,
//   `Observation`, `LlmWorker` and their result shapes are exported — a consumer cannot implement
//   an interface it cannot name. The engine's own implementations of them are internal.
//
// Reading a run goes through `RunArchive`, not through the stores under it: `getRunsForRoot`,
// `listRootRuns`, `readJsonBlob` and `runBlobDir` are not exported, because a consumer that has
// them ends up rebuilding `.path/`'s layout for itself, which is how the layout became part of
// @path/server's contract. `openDb`/`dbFilePath`/`pathDir`/`rootRunTreeDir` stay: they address
// `.path/` without interpreting it, which is what a test asserting on-disk artifacts needs.
//
// Domain vocabulary — run status, log events, traces, the run record, the v0 wire shapes — is
// @path/schema's (#66), and is not re-exported here. An engine consumer that needs to name a run
// imports it from the package that defines what a run is.
