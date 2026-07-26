// @path/client-core — the pure-TS, zero-framework core every viewer/designer/mobile surface
// consumes: a typed client over the `@path/server` v0 API, an SSE client with Last-Event-ID
// reconnect/replay, and a framework-agnostic run view-model. No React, no DOM.
// Normative contract: docs/api/server-api-v0.md; vocabulary: CONTEXT.md.

// Surfaces get the domain status and log-event types from this core, not from `@path/engine`
// directly: the engine is a Node package (SQLite, fs), and a browser surface should have exactly one
// seam — this one. `LogEvent` is the narrative's element type, so a surface that renders the stream
// needs to name it.
export type { LogEvent, RunStatus } from "@path/engine";

// Blob contents and a run's `output` are arbitrary JSON, so a surface that renders them names the
// type — and names it from here, for the same one-seam reason.
export type { JsonValue } from "@path/schema";

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
  isTerminal,
  type RunNodeState,
  type RunViewState,
  type RunViewListener,
  type StreamPhase,
} from "./view-model.js";

export { connectRunViewModel, type ConnectedRun, type ConnectRunOptions } from "./connect.js";
