export { type LoadedWorkflow, type LoadResult, loadWorkflowTree } from "./load-workflow-tree.js";
export { LOG_BACKEND_IDS, type LogBackendId } from "./logging/backends.js";
export { LOG_FORMAT, type LogBackend, type LogFormat } from "./logging/log-backend.js";
export { readNdjsonLog } from "./logging/ndjson-backend.js";
export { openDb, SchemaVersionError } from "./persistence/db.js";
export {
  acquireMarkerLease,
  DEFAULT_MARKER_CODEC,
  type MarkerCodec,
  type MarkerLeaseGrant,
  type MarkerLeaseMarker,
  type MarkerLeaseRequest,
  type MarkerLeaseResult,
  readMarkerLease,
  releaseMarkerLease,
  removeMarkerLease,
  renewMarkerLease,
} from "./persistence/marker-lease.js";
export { dbFilePath, pathDir, rootRunTreeDir } from "./persistence/paths.js";
export { type LoadedStepPluginRegistry, loadStepPluginRegistry } from "./plugin-seam/scan.js";
export {
  type CompleteResult,
  type EligibilityRow,
  type EligibilityVerdict,
  type ListEligibleResult,
  type OpenProjectResult,
  openProject,
  type Project,
  type ProjectContinuationOptions,
  type ProjectLaunchOptions,
  type ProjectResumeOptions,
  type ProjectRunOptions,
  type ResumeResult,
} from "./project.js";
export type {
  ListRootsOptions,
  RunArchive,
  RunBlobName,
  RunTree,
} from "./run-archive.js";
export {
  ObserverError,
  type RunEvent,
  type RunObserver,
  type RunOutcome,
  type RunPayload,
  type UnsequencedLogEvent,
  WORKFLOW_STEP_TYPE,
} from "./run-observer.js";
export {
  type ContinuationInput,
  type ContinuationRunOptions,
  type ContinueInput,
  type LaunchRunOptions,
  type ResumeInput,
  type RunOptions,
  type RunResult,
  runWorkflow,
  type WorkerOverrides,
} from "./run-workflow.js";
export { type ValidateWorkflowFileResult, validateWorkflowFile } from "./validate-workflow-file.js";

// What a consumer may name is what it needs to *use* the engine, not what the engine is built from.
// Assembly is not exported: `openProject` and `runWorkflow` own their composition, and exporting
// the ingredients lets a consumer rebuild it by hand, in the wrong order. A seam's vocabulary stays
// even when its default adapter goes, because a consumer cannot implement an interface it cannot
// name (worker substitution lives in `@path/engine/plugin`, ADR 0021 sub-15). Reading a run goes
// through `RunArchive`, so a consumer cannot rebuild `.path/`'s layout for itself;
// `openDb`/`dbFilePath`/ `pathDir`/`rootRunTreeDir` stay, because they address `.path/` without
// interpreting it. Domain vocabulary — run status, log events, the run record, the v0 wire shapes —
// is @path/schema's.
