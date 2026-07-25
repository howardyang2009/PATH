// @path/client-core — the pure-TS, zero-framework core every viewer/designer/mobile surface
// consumes: a typed client over the `@path/server` v0 API, an SSE client with Last-Event-ID
// reconnect/replay, and a framework-agnostic run view-model. No React, no DOM.
// Normative contract: docs/api/server-api-v0.md; vocabulary: CONTEXT.md.

// Re-exported so surfaces reach the domain status type through this core rather than importing
// `@path/engine` directly — the engine is a Node package (SQLite, fs) and must not enter a browser
// bundle's dependency graph, even type-only.
export type { RunStatus } from "@path/engine";

export type {
  WireRunRecord,
  RunTreeResponse,
  RootRunSummary,
  ListRunsResponse,
  WireError,
  BlobName,
} from "./wire-types.js";

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
} from "./view-model.js";

export { connectRunViewModel, type ConnectedRun, type ConnectRunOptions } from "./connect.js";
