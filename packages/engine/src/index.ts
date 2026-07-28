export { loadWorkflowTree, type WorkflowTree, type LoadResult } from "./load-workflow-tree.js";
export { runWorkflow, type RunOptions, type RunResult } from "./run-workflow.js";
export { openProject, type OpenProjectResult, type Project, type ProjectRunOptions } from "./project.js";
export {
  createRunArchive,
  openRunArchive,
  type ListRootsOptions,
  type OpenRunArchiveResult,
  type RunArchive,
  type RunBlobName,
  type RunTree,
} from "./run-archive.js";
export { composeObservers, type Observation, ObserverError, type RunObserver, type RunOutcome } from "./run-observer.js";
export { collectSecrets, type SecretMasker } from "./secret-mask.js";
export { LOG_FORMAT, type LogBackend, type LogFormat } from "./logging/log-backend.js";
export { readNdjsonLog } from "./logging/ndjson-backend.js";
export { createLoggingObserver } from "./logging/logging-observer.js";
export {
  createLogBackends,
  DEFAULT_LOG_BACKENDS,
  LOG_BACKEND_IDS,
  isLogBackendId,
  type LogBackendId,
} from "./logging/backends.js";
export { main, type CliIo } from "./cli.js";
export { createAgentSdkWorker, type AgentSdkWorkerOptions, type SdkQuery } from "./llm/agent-sdk-worker.js";
export type { LlmWorker, PromptRequest, PromptResult } from "./llm/llm-worker.js";
export {
  createProcessorSemaphore,
  DEFAULT_LLM_CONCURRENCY,
  type ProcessorSemaphore,
  type ReleaseSlot,
} from "./llm/processor-semaphore.js";
export { openDb, SchemaVersionError } from "./persistence/db.js";
export { dbFilePath, pathDir, rootRunTreeDir } from "./persistence/paths.js";
export { ensurePathDirGitignore } from "./persistence/gitignore.js";
export { createPersistedObserver } from "./persistence/persisted-observer.js";

// Reading a run goes through `RunArchive`, not through the stores under it: `getRunsForRoot`,
// `listRootRuns`, `readJsonBlob` and `runBlobDir` are no longer exported, because a consumer that
// has them ends up rebuilding `.path/`'s layout for itself, which is how the layout became part of
// @path/server's contract. `openDb`/`dbFilePath`/`pathDir`/`rootRunTreeDir` stay: they address
// `.path/` without interpreting it, which is what a test asserting on-disk artifacts needs.
//
// Domain vocabulary — run status, log events, traces, the run record, the v0 wire shapes — is
// @path/schema's (#66), and is not re-exported here. An engine consumer that needs to name a run
// imports it from the package that defines what a run is.
