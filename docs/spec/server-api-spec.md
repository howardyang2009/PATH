# PATH Server API Specification (v0)

Resolves wayfinder ticket [#34](https://github.com/howardyang2009/PATH/issues/34) — the destination
artifact of [Wayfinder map: PATH server API](https://github.com/howardyang2009/PATH/issues/29). This
document assembles every closed decision of that map into one buildable spec for `@path/server`: an
**HTTP/IPC boundary over `@path/engine`**, the door the [MVP spec](./mvp-spec.md) (§10 deferred
register) held open for "Website/cloud, remote engines, mobile."

**How to read this document.** Vocabulary follows [CONTEXT.md](../../CONTEXT.md). The endpoint
contract already has a normative document and is *incorporated by reference*, not restated:
[docs/api/server-api-v0.md](../api/server-api-v0.md). Everything else — architecture, versioning,
lifecycle, scope boundary — previously lived only in tracker resolutions and is stated normatively
**here**. Where this document and a tracker comment disagree, this document wins. §7 maps every
section back to its originating decision.

---

## 1. Scope

**In this spec:**

- A new package, `@path/server`, TypeScript on Node LTS, alongside `@path/schema` and
  `@path/engine` in the existing monorepo.
- One HTTP + SSE API surface (4 endpoints, v0): start a run, list runs, get run status/tree, stream
  run events. Full contract: [docs/api/server-api-v0.md](../api/server-api-v0.md).
- A separate CLI entry point, `path-server`, for starting the server against a fixed project
  directory.
- No auth, no multi-project routing, no cancel-run capability — v0 keeps the same trust boundary
  and execution guarantees `@path/engine`'s CLI already has, just reachable over HTTP.

**Out of scope** (ruled out by the map; return only via a redrawn destination):

- Web monitor UI, Flutter multi-platform runner, visual workflow design UI — each is its own future
  map, blocked on this spec existing first.
- Auth/tokens, multi-project routing, cancel-run — deferred; the door stays open (§6) but nothing
  here builds it.
- Any change to `@path/engine`'s execution semantics. This package is a pure wrapper: it imports
  and calls the engine, it does not extend what the engine can do.

## 2. Architecture & package layout

- **Package**: `@path/server`, new sibling to `@path/schema`/`@path/engine` in the pnpm workspace.
  Depends on `@path/engine` as a normal workspace dependency.
- **Execution model**: in-process. `@path/server` imports `runWorkflow`, `loadWorkflowTree`, the
  observer/log-backend seam (`composeObservers`, `createPersistedObserver`,
  `createLoggingObserver`, `createLogBackends`) directly from `@path/engine`'s `index.ts` — no
  subprocess, no shelling to the `path` CLI. This is what those exports already exist for.
- **Transport**: HTTP + Server-Sent Events. No WebSocket, no raw IPC socket — HTTP is the one
  transport that serves both a local client today and a remote website later without a protocol
  change.
- **Auth**: none. The server binds to `localhost` only; this is the same trust boundary
  `.path/`-on-disk already has today (anyone with filesystem/process access on the machine can
  reach it), just reachable over a socket instead of a CLI invocation. Token auth is deferred —
  graduates only when remote access is a real destination, not this one.
- **Project scope**: one server instance serves one fixed project root, set at startup (§4). No
  request carries an arbitrary filesystem path; no multi-project routing exists in v0.
- **Concurrency**: multiple root runs may execute concurrently against one server instance, with no
  server-side queueing. This falls out of the engine's existing design, not new work: run
  persistence and log backends are already keyed per root run (mvp spec §6, §8), and the LLM
  fan-out semaphore is already engine-wide rather than per-run (mvp spec §5.5) — nothing coordinates
  root runs against each other today, and this spec doesn't add anything that would.
- **Cancellation**: no cancel-run endpoint. Root runs are never cancelled in the engine today (mvp
  spec §5.6) — exposing cancellation over HTTP would require new engine-level capability, which is
  explicitly out of scope for a wrapper package.

## 3. API contract

Normative: [docs/api/server-api-v0.md](../api/server-api-v0.md). Summary:

| Endpoint | Purpose |
| --- | --- |
| `POST /v0/runs` | Start a root run (async — returns `{run_id, root_run_id}` immediately). |
| `GET /v0/runs` | List root runs, most recent first. |
| `GET /v0/runs/:root_run_id` | Run status + full run tree. |
| `GET /v0/runs/:root_run_id/events` | SSE stream of `LogEvent`s, with standard `Last-Event-ID` reconnect/replay off the NDJSON backend. |

JSON bodies are snake_case, matching the existing wire conventions in this codebase (the log-event
envelope, the workflow format's `max_iterations`) rather than the camelCase used in `@path/engine`'s
internal `RunRecord`/`RunResult` types — the server translates at the boundary.

Two small additive gaps the endpoint doc surfaced and this spec accepts as implementation work, not
open decisions: a "list root runs" query in `run-store` (nothing today queries by anything but a
known `root_run_id`), and no blob-serving endpoint (`input_ref`/`output_ref` point at paths under
the server's own project root, which a co-located client reads directly).

## 4. Versioning & lifecycle

- **Versioning**: path-prefixed, `/v0`. Mirrors the workflow format's self-declaring
  `path/workflow@0` (mvp spec §4) — a breaking contract change ships as `/v1` alongside `/v0`, never
  a silent reshape of an existing path.
- **CLI surface**: a separate bin, `path-server` (not a `path serve` subcommand — the package
  boundary decision in §2 rules that out). Invocation: `path-server [project-dir] [--port <n>]`.
  `project-dir` defaults to cwd, mirroring `path run`'s cwd-based `.path/` resolution. `--port`
  defaults to an OS-assigned ephemeral port when omitted, printed to stdout on startup
  (`Listening on http://localhost:<port>`) so a launching client can capture it without
  pre-agreeing on a fixed port.

## 5. Acceptance

Recommended, pending human sign-off: this spec is done when the existing
[release-notes acceptance pipeline](../acceptance-workflow/NOTES.md) — the same workload mvp spec
§11 already runs end-to-end via `path run` — can instead be driven entirely through
`@path/server`:

1. `POST /v0/runs` with the release-notes workflow starts the pipeline and returns a `root_run_id`;
2. `GET /v0/runs/:root_run_id/events` streams the full run narrative live, matching what `run.log`
   already records today;
3. `GET /v0/runs/:root_run_id` reports `succeeded` with the same run tree `path runs` would show on
   disk;
4. a client that connects to the events stream, disconnects mid-run, and reconnects with
   `Last-Event-ID` sees no gap in the narrative.

No new acceptance workload is needed — the point of this spec is that the existing engine
capability becomes reachable over HTTP, not that new engine capability gets built.

## 6. Deferred register (doors deliberately held open)

| Deferred | Where the door is |
| --- | --- |
| Auth (bearer token) | localhost-only trust boundary stated explicitly (§2); additive header check |
| Multi-project routing | single-fixed-root today; a project path per request is the additive shape |
| Cancel-run endpoint | blocked on `@path/engine` gaining external abort capability first |
| Db-backed SSE replay | v0 replays from NDJSON only; a database read-back query is the door if `ndjson` backend independence is ever needed |
| Web monitor UI | own future map, consumes this API |
| Flutter multi-platform runner | own future map, consumes this API |
| Visual workflow design UI | own future map, much larger scope (graph editor) |

## 7. Decision record

| Section | Decision ticket |
| --- | --- |
| Destination & scope (§1) | [map #29](https://github.com/howardyang2009/PATH/issues/29) |
| Transport, package, execution model, auth, project scope, concurrency, cancellation (§2) | pre-chart grilling, recorded on [map #29](https://github.com/howardyang2009/PATH/issues/29) |
| API endpoint surface (§3) | [#30](https://github.com/howardyang2009/PATH/issues/30) → [docs/api/server-api-v0.md](../api/server-api-v0.md) |
| Event-stream reconnect/replay (§3) | [#31](https://github.com/howardyang2009/PATH/issues/31) |
| API versioning (§4) | [#32](https://github.com/howardyang2009/PATH/issues/32) |
| Server lifecycle & CLI surface (§4) | [#33](https://github.com/howardyang2009/PATH/issues/33) |
| Spec assembly (this document) | [#34](https://github.com/howardyang2009/PATH/issues/34) |
