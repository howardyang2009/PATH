// @path/client-core — the pure-TS, zero-framework core every viewer/designer/mobile surface
// consumes: a typed client over the `@path/server` v0 API, an SSE client with Last-Event-ID
// reconnect/replay, and a framework-agnostic run view-model. No React, no DOM.
// Normative contract: docs/api/server-api-v0.md; vocabulary: CONTEXT.md.

// Surfaces name the domain through this one seam rather than reaching past it. Everything below
// originates in `@path/schema`, which since #66 owns the runtime vocabulary as well as the workflow
// format — so this package no longer depends on `@path/engine` at all, and a browser surface no
// longer sits one import away from SQLite, child processes and the Agent SDK.
export {
  isTerminal,
  type BlobName,
  type JsonValue,
  type ListRunsResponse,
  type LogEvent,
  type RootRunSummary,
  type RunRecord,
  type RunStatus,
  type RunTreeResponse,
  type WireError,
  type WireRunRecord,
} from "@path/schema";

export {
  PathApiClient,
  PathApiError,
  type PathApiClientOptions,
  type ListRunsQuery,
  type FetchLike,
} from "./api-client.js";

export {
  subscribeRunEvents,
  type SubscribeRunEventsOptions,
  type RunEventSubscription,
} from "./sse-client.js";

export {
  RunViewModel,
  type RunNodeState,
  type RunViewState,
  type RunViewListener,
  type StreamPhase,
} from "./view-model.js";

export { connectRunViewModel, type ConnectedRun, type ConnectRunOptions } from "./connect.js";
