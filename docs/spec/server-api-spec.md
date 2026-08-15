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
- One HTTP + SSE API surface (v0): start a run, list runs, get run status/tree, stream run events,
  cancel a run. Full contract: [docs/api/server-api-v0.md](../api/server-api-v0.md).
- A separate CLI entry point, `path-server`, for starting the server against a fixed project
  directory.
- No auth, no multi-project routing — v0 keeps the same trust boundary and execution guarantees
  `@path/engine`'s CLI already has, just reachable over HTTP.

**Out of scope** (ruled out by the map; return only via a redrawn destination):

- Web monitor UI, Flutter multi-platform runner, visual workflow design UI — each is its own future
  map, blocked on this spec existing first.
- Auth/tokens, multi-project routing — deferred; the door stays open (§6) but nothing here builds it.
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
- **`$env` in operator-supplied config is rejected; a literal `$secret` is accepted.** `POST
  /v0/runs` validates operator config with `ConfigObjectSchema`, then refuses any `{"$env": "NAME"}`
  wrapper in it — including the composed `{"$secret": {"$env": "NAME"}}` form — with a `400`
  ([ADR 0012](../adr/0012-operator-config-rejects-env-wrapper.md), [#231](https://github.com/howardyang2009/PATH/issues/231)).
  This reverses the earlier "argued, not gated" stance. That stance held `$env` "adds no new power"
  because a caller who can post config can already post a `binary` step that inherits the process
  environment — but the browser launch surface ([#228](https://github.com/howardyang2009/PATH/issues/228))
  breaks the equivalence: the viewer launches *discovered* workflows and cannot author a `binary`
  step, so `$env` on the override path would hand a browser user an env-read power they do not
  otherwise have. This is the boundary-move this spec pre-committed to re-open on. Launch-time
  security material must come from the website user (a literal `$secret`, masked on the return path,
  CONTEXT.md → Secret), not the server box. The reject is uniform across every caller (one no-auth
  same-origin endpoint cannot tell a browser `fetch` from a `curl`) and applies **only to
  operator-supplied override config** — an `$env` wrapper authored inside a `workflow.json` is
  untouched. CSRF/cross-origin remains a separate, deferred concern (the config envelope is the wrong
  layer for it); it graduates with the auth/origin hardening below.
- **Concurrency**: multiple root runs may execute concurrently against one server instance, with no
  server-side queueing. This falls out of the engine's existing design, not new work: run
  persistence and log backends are already keyed per root run (mvp spec §6, §8), and the LLM
  fan-out semaphore is already engine-wide rather than per-run (mvp spec §5.5) — nothing coordinates
  root runs against each other today, and this spec doesn't add anything that would.
- **Cancellation**: `POST /v0/runs/:root_run_id/cancel`, added by
  [#54](https://github.com/howardyang2009/PATH/issues/54) once the engine gained external abort
  ([#52](https://github.com/howardyang2009/PATH/issues/52)) — the blocker this spec originally
  recorded. It stays a wrapper: the route holds the `AbortController` whose signal it handed
  `runWorkflow`, keyed by `root_run_id`, and signalling it is the whole of what the route does. So
  the engine's contract is the server's contract — best-effort, root runs only, no force path and no
  deadline (mvp spec §5.6). The corollary is a real refusal: a run is cancellable only from the
  process executing it, and `.path/path.db` is shared with `path run`, so a `running` row this
  server did not start is a `409`, not a cancel. No `cancelling` status was added to the enum; the
  unwind window is not modelled on the wire or in the db.

## 3. API contract

Normative: [docs/api/server-api-v0.md](../api/server-api-v0.md). Summary:

| Endpoint | Purpose |
| --- | --- |
| `POST /v0/runs` | Start a root run (async — returns `{run_id, root_run_id}` immediately). |
| `GET /v0/runs` | List root runs, most recent first. |
| `GET /v0/runs/:root_run_id` | Run status + full run tree. |
| `GET /v0/runs/:root_run_id/events` | SSE stream of `LogEvent`s, with standard `Last-Event-ID` reconnect/replay off the NDJSON backend. |
| `POST /v0/runs/:root_run_id/cancel` | Cancel a root run in flight (async — `202` once the abort is signalled, not once the run is terminal). |

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
| Db-backed SSE replay | v0 replays from NDJSON only; a database read-back query is the door if `ndjson` backend independence is ever needed |
| Web monitor UI | own future map, consumes this API |
| Flutter multi-platform runner | own future map, consumes this API |
| Visual workflow design UI | own future map, much larger scope (graph editor) |

## 7. Decision record

| Section | Decision ticket |
| --- | --- |
| Destination & scope (§1) | [map #29](https://github.com/howardyang2009/PATH/issues/29) |
| Transport, package, execution model, auth, project scope, concurrency (§2) | pre-chart grilling, recorded on [map #29](https://github.com/howardyang2009/PATH/issues/29) |
| Cancellation (§2, §3) | [#54](https://github.com/howardyang2009/PATH/issues/54), unblocked by [#52](https://github.com/howardyang2009/PATH/issues/52) — supersedes the "no cancel-run capability" position recorded on [map #29](https://github.com/howardyang2009/PATH/issues/29) |
| API endpoint surface (§3) | [#30](https://github.com/howardyang2009/PATH/issues/30) → [docs/api/server-api-v0.md](../api/server-api-v0.md) |
| Event-stream reconnect/replay (§3) | [#31](https://github.com/howardyang2009/PATH/issues/31) |
| API versioning (§4) | [#32](https://github.com/howardyang2009/PATH/issues/32) |
| Server lifecycle & CLI surface (§4) | [#33](https://github.com/howardyang2009/PATH/issues/33) |
| Spec assembly (this document) | [#34](https://github.com/howardyang2009/PATH/issues/34) |
