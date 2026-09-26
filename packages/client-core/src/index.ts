// @path/client-core — the pure-TS, zero-framework core every viewer/designer/mobile surface
// consumes: a typed client over the `@path/server` v0 API, an SSE client with Last-Event-ID
// reconnect/replay, and a framework-agnostic run view-model. No React, no DOM.
// Normative contract: docs/api/server-api-v0.md; vocabulary: CONTEXT.md.
//
// This barrel is the convenience default. The package's `exports` map also names the seams a surface
// can import narrowly — `@path/client-core/api-client` (the typed HTTP client),
// `/view-model` (the event-folded run state), `/complete-form` (the Complete form model) and
// `/blob-source` (a run's blob addressing) — so an import says which module owns a name. Each is
// pinned by `test/subpath.test.ts`, since a package `exports` path is not something tsc alone checks.

// Surfaces name the domain through this one seam rather than reaching past it. Everything below
// originates in `@path/schema`, which since #66 owns the runtime vocabulary as well as the workflow
// format — so this package no longer depends on `@path/engine` at all, and a browser surface no
// longer sits one import away from SQLite, child processes and the Agent SDK.
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
// The Viewer/Designer awaiting surface (issue #486, ADR 0040): the `person-activity` node read from the
// workflow file by id, and the framework-free Complete-form model — field list, value coercion, client
// pre-check, and the server `400`→field mapping — so both surfaces draw the same form and read the same
// errors. The React components keep only their own inputs on the other side (spec § Shared seam).
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
// What a run's events and rows *mean*, as against how a surface draws them. Both answer questions
// with one right answer — how an event moves a run's status, whether the root run is finished, and
// which run spawned which — so a second surface reaching different answers would be showing a
// different run, not a differently styled one.
export { eventOutcome, isRootRunFinished, runStatusAfter } from "./event-outcome.js";
// The framework-free run-logic seam both the Viewer and the Designer read (#359, spec § Shared
// seam). Each unit has one right answer a second surface must reach identically: how a launch field
// is gated before a request is spent, how one node is named, what one log event says, and what a
// missing blob means. The surfaces keep only their own wiring — the launch form's inputs, the run
// tree's rows, the narrative's list, the blob hook's `useState`/`useEffect` — on the other side.
export { type JsonFieldResult, type ParseJsonFieldOptions, parseJsonField } from "./launch-json.js";
// The launch-facts secret-restore contract shared by both continuation surfaces (Resume and Complete,
// ADR 0046): the config field's show/skeleton state, and the one submit-gate verdict — parse, blank
// secret paths, whether it may submit, and the block message — so neither surface re-derives it.
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
// The Designer's `Resume from …` button's eager legal-K check (spec § Resume from here, ADR 0033):
// the client mirror of the engine's one legal-K rule, computed from the run tree + the open file so an
// illegal K greys before any round-trip; the engine's `refusal` stays the authority for a race.
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
// The folder tree behind every workflow picker: one grouping of the flat discovery list both the
// Viewer's launch panel and the Designer's open dialog draw the same way (#359 shared seam).
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
