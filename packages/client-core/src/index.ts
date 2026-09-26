// @path/client-core — the pure-TS, zero-framework core every viewer/designer/mobile surface consumes:
// a typed client over the @path/server v0 API, an SSE client with Last-Event-ID replay, and a
// framework-agnostic run view-model. Contract: docs/api/server-api-v0.md; vocabulary: CONTEXT.md.

// Surfaces name the domain through this one seam; everything below originates in `@path/schema`, so
// this package depends on no engine and a browser never sits one import from SQLite.
export {
  type BlobName,
  type CompleteRunRequest,
  type CompleteRunResponse,
  type ConfigObject,
  type GetTemplateResponse,
  isIterationRun,
  isPassRun,
  isReuseRow,
  isRootRun,
  isTerminal,
  type JsonValue,
  type ListRunsResponse,
  type ListTemplatesResponse,
  type ListWorkflowsResponse,
  type LogBackendId,
  type LogEvent,
  type RootRunSummary,
  type RunRecord,
  type RunStatus,
  type RunTreeResponse,
  type StartRunRequest,
  type StartRunResponse,
  type StepPluginsResponse,
  type TemplateSummary,
  type WireError,
  type WireFieldSpec,
  type WireRunRecord,
  type WireStepPlugin,
  type WorkflowFile,
  type WorkflowSummary,
} from "@path/schema";

export {
  type AcquireLockInput,
  type AcquireLockResult,
  type CreateTemplateInput,
  type FetchLike,
  type HeartbeatResult,
  type LeaseOpInput,
  type ListRunsQuery,
  PathApiClient,
  type PathApiClientOptions,
  PathApiError,
  type PutTemplateInput,
  type PutWorkflowInput,
  type PutWorkflowResult,
  type StartRunOptions,
  type TemplateWriteResult,
  type WorkflowFileRaw,
  type WorkflowLease,
} from "./api-client.js";
// The awaiting surface (ADR 0040): the `person-activity` node read from the workflow file by id, and
// the framework-free Complete-form model both surfaces draw.
export {
  AWAITING_STEP_TYPE,
  type AwaitingNode,
  awaitingNodeForRun,
  findAwaitingNode,
} from "./awaiting-node.js";
export {
  type BlobContent,
  type BlobReadPlan,
  planBlobRead,
  resolveBlobError,
} from "./blob-absence.js";
export { type RunBlobSource, runBlobSource } from "./blob-source.js";
export {
  buildCompleteFields,
  type CompleteField,
  type CompleteFieldKind,
  type CompleteFieldValue,
  coerceCompleteOutput,
  coerceRawCompleteOutput,
  type MappedCompleteErrors,
  mapCompleteErrors,
  validateCompleteDraft,
} from "./complete-form.js";
export { type ConnectedRun, type ConnectRunOptions, connectRunViewModel } from "./connect.js";
export { eventMessage } from "./event-message.js";
// What a run's events and rows *mean*, as against how a surface draws them: one right answer each, so a
// second surface reaching a different answer would be showing a different run.
export { eventOutcome, isRootRunFinished, runStatusAfter } from "./event-outcome.js";
// The framework-free run-logic seam the Viewer and the Designer both read: how a launch field is gated,
// how one node is named, what one log event says, and what a missing blob means.
export { type JsonFieldResult, type ParseJsonFieldOptions, parseJsonField } from "./launch-json.js";
// The launch-facts secret-restore contract shared by Resume and Complete (ADR 0046): the config
// field's show/skeleton state and the one submit-gate verdict.
export {
  blankSecretMessage,
  blankSecretPaths,
  type ContinuationVerb,
  type LaunchSecretResupply,
  launchSecretResupply,
  type ResupplyGate,
  resupplyGate,
  secretSkeletonJson,
} from "./launch-secret-resupply.js";
export { nodeEventLabel, nodeLabel } from "./node-label.js";
export { loadReachableWorkflowFiles } from "./reachable-workflow-files.js";
// The Designer's eager legal-K check (ADR 0033): the client mirror of the engine's one legal-K rule; the
// engine's `refusal` stays the authority for a race.
export {
  type ResumeFromContainer,
  type ResumeFromEligibility,
  type ResumeFromEligibilityArgs,
  type ResumeFromReasonCode,
  resumeFromEligibility,
  shortRunId,
} from "./resume-from-eligibility.js";
export { buildRunTree, displayStatusByRun, type RunTreeNode } from "./run-tree.js";
export {
  type RunEventSubscription,
  type SubscribeRunEventsOptions,
  subscribeRunEvents,
} from "./sse-client.js";
export {
  type RunNodeState,
  type RunViewFacts,
  type RunViewListener,
  RunViewModel,
  type RunViewState,
  type StreamPhase,
} from "./view-model.js";
// The folder tree behind every workflow picker, drawn from the flat discovery list.
export {
  buildWorkflowTree,
  countWorkflowLeaves,
  isFolderOnOpenChain,
  nextOpenFolder,
  parentFolderPath,
  type WorkflowTreeFolder,
  type WorkflowTreeLeaf,
  type WorkflowTreeNode,
  workflowBaseName,
} from "./workflow-tree.js";
