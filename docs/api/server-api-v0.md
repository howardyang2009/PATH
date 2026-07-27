# PATH Server API v0 — Endpoint Surface

Resolves wayfinder ticket [#30](https://github.com/howardyang2009/PATH/issues/30), part of
[Wayfinder map: PATH server API](https://github.com/howardyang2009/PATH/issues/29). This document
is the normative definition of the `@path/server` v0 HTTP contract. Vocabulary follows
[CONTEXT.md](../../CONTEXT.md). Server lifecycle/CLI surface and SSE reconnect/replay semantics are
owned by sibling tickets ([#33](https://github.com/howardyang2009/PATH/issues/33),
[#31](https://github.com/howardyang2009/PATH/issues/31)) — this document fixes the endpoint list
and the request/response shapes.

**Versioning ([#32](https://github.com/howardyang2009/PATH/issues/32)):** path-prefixed, mirroring
the workflow format's self-declaring `path/workflow@0`. Every endpoint below lives under `/v0`; a
breaking change to the contract ships as `/v1` alongside it, never a silent reshape of `/v0`.

## 0. Constraints (from the map, not re-litigated here)

- Transport: HTTP + SSE only. No WebSocket, no raw IPC socket.
- `@path/server` is a new package, imports `@path/engine` **in-process** (`runWorkflow`,
  `loadWorkflowTree`, log backends) — not a CLI subprocess wrapper.
- No auth. Localhost-bind only.
- Single fixed project root per server instance, set at startup — one `.path/` tree, like `path run`.
- Multiple root runs may execute concurrently; no server-side queueing.
- Cancellation is **best-effort and root-only** (mvp spec §5.6), because that is exactly what the
  engine's external abort ([#52](https://github.com/howardyang2009/PATH/issues/52)) delivers — the
  server does not promise more than the engine does. No force/kill escalation, no timeout, and no
  route for cancelling a nested run or a single step. The endpoint is §4.2.

## 1. Conventions

- All request/response bodies are JSON, `Content-Type: application/json`.
- **Field casing is snake_case**, matching the existing wire conventions in this codebase (log-event
  envelope's `run_id`/`node_id`, the format's `max_iterations`) — not the camelCase used internally
  in `RunRecord`/`RunResult`. The server translates at the boundary.
- Errors share one shape:
  ```json
  { "error": { "message": "human-readable summary", "details": "<optional>" } }
  ```
  `details` carries structured data where available (e.g. zod validation issues from
  `loadWorkflowTree`), otherwise omitted.
- A `root_run_id` always equals its own `run_id` for a root run — the two ever diverge only for
  non-root rows returned inside a run tree (§3).

## 2. `POST /v0/runs` — start a run

Async only (locked decision): returns as soon as the run is accepted and validated, before
execution finishes. Client polls `GET /v0/runs/:root_run_id` or streams `GET
/v0/runs/:root_run_id/events`.

Request body:

```json
{
  "workflow_path": "release-notes.workflow.json",
  "input": { "...": "..." },
  "config": { "...": "..." },
  "log_backends": ["db", "ndjson"],
  "llm_concurrency": 4
}
```

| Field | Required | Maps to (`RunOptions` / CLI flag) |
| --- | --- | --- |
| `workflow_path` | yes | Path to the root workflow file, resolved against the server's fixed project root — same resolution `path run <workflow.json>` does today. |
| `input` | no | `RunOptions.input` — seeds the root run's context. |
| `config` | no | `RunOptions.operatorConfig` — same override semantics as `--config`/`--set`. |
| `log_backends` | no | Same as `path run --log-backends`. Omitted: the project's `.path/settings.json` `"log.backends"`, else `["db", "ndjson"]`. |
| `llm_concurrency` | no | Same as `path run --llm-concurrency`. Omitted: the project's `.path/settings.json` `"llm.concurrency"`, else the engine default (4). |

The two engine settings resolve the same way here as they do for `path run`, nearest wins: **request
field > `.path/settings.json` > built-in default** (mvp spec §9). Before #64 the server ignored the
settings file, so an operator who had configured one saw it apply to `path run` and not to the API.
A malformed settings file now fails server startup rather than being silently skipped, matching how
`path run` refuses to start.

Responses:

- `202 Accepted` — workflow tree loaded and validated, run started:
  ```json
  { "run_id": "<uuid>", "root_run_id": "<uuid>" }
  ```
  (`run_id` and `root_run_id` are always equal here — the field is duplicated for shape-parity with
  `GET /v0/runs`/`GET /v0/runs/:id`, which both return the same envelope for non-root run rows.)
- `400 Bad Request` — `workflow_path` missing/not found, or `loadWorkflowTree` validation failure.
  `error.details` carries the validation issues.
- `404 Not Found` — `workflow_path` resolves outside the project root, or the file doesn't exist.

## 3. `GET /v0/runs` — list root runs

New capability; the engine has no "list root runs" query today (`getRunsForRoot` requires a known
`root_run_id`). Requires one small additive `run-store` function: root runs are exactly the rows
where `run_id = root_run_id`.

Query params: `limit` (default 50), `status` (optional filter: one of `RunStatus`).

Response `200 OK`:

```json
{
  "runs": [
    {
      "run_id": "<uuid>",
      "status": "succeeded",
      "started_at": "2026-07-21T10:00:00.000Z",
      "finished_at": "2026-07-21T10:02:31.000Z"
    }
  ]
}
```

Most recent first (`ORDER BY started_at DESC`). This is the root-run summary shape only — no
`output`/`usage`/full tree; fetch `GET /v0/runs/:root_run_id` for that.

## 4. `GET /v0/runs/:root_run_id` — run status + tree

Response `200 OK`, one row per `RunRecord` in the tree (`getRunsForRoot`, camelCase fields
translated to snake_case):

```json
{
  "root_run_id": "<uuid>",
  "status": "succeeded",
  "output": { "...": "..." },
  "runs": [
    {
      "run_id": "<uuid>",
      "root_run_id": "<uuid>",
      "parent_run_id": null,
      "node_id": null,
      "worker": { "...": "..." },
      "status": "succeeded",
      "started_at": "...",
      "finished_at": "...",
      "input_ref": "runs/<root_run_id>/<run_id>/input.json",
      "output_ref": "runs/<root_run_id>/<run_id>/output.json",
      "usage": null,
      "estimated_cost_usd": null
    }
  ]
}
```

- Top-level `status`/`output` mirror the root row (first entry of `runs`, `parent_run_id: null`) —
  duplicated at the top for a client that only wants the summary.
- `input_ref`/`output_ref` are the same project-relative blob paths the engine already stores
  (`blobRef`). A co-located client can read them off disk directly; a browser client cannot, so
  issue #43 added the blob route below (§4.1) to serve their content over HTTP.
- `404 Not Found` if `root_run_id` is unknown.

### 4.1 `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — one run's input or output object

Added by issue #43 for browser clients, which cannot read `input_ref`/`output_ref` off the server's
filesystem. `name` is a fixed enum — `input` or `output` — never a raw filename, so the path cannot
escape the run's blob directory. Response `200 OK` with the blob's content as `application/json`,
verbatim: blobs are already secret-masked on disk (masking happens at the persistence boundary), so
the route serves what it reads.

- `404 Not Found` if `root_run_id` is unknown, `run_id` is not in that root's tree, `name` is not a
  served blob, or the blob file is absent (a run has no output until it finishes).
- `context`/`stderr` blobs are deferred (map #40) — they resolve as unknown names.

### 4.2 `POST /v0/runs/:root_run_id/cancel` — stop a root run in flight

Added by issue [#54](https://github.com/howardyang2009/PATH/issues/54), once the engine could be
aborted from outside ([#52](https://github.com/howardyang2009/PATH/issues/52)). A **named action**,
not a mutation of a status field and not a `DELETE` — `DELETE` keeps meaning "remove the record" if
it ever ships, and the run record is the audit trail, which must survive a cancel. No request body.

Root runs only, and best-effort: this signals the abort the engine already understands and adds no
force path and no deadline of its own (§0).

Responses:

- `202 Accepted` — the abort was **signalled**:
  ```json
  { "root_run_id": "<uuid>" }
  ```
  Like `POST /v0/runs` (§2), the response goes out before the run finishes: an in-flight SDK turn can
  take seconds to unwind and there is no bound to hang a request on. The client learns the real
  terminal status from the SSE stream (§5) it is already watching, or by polling §4 — not from this
  response. The status enum is unchanged; there is no `cancelling` status on the wire or in the db,
  so a client that wants to show the unwind window holds that state locally.

  Repeating the call while the run is still unwinding answers `202` again — aborting an already
  aborted run is a no-op, so a double click is safe.
- `404 Not Found` — no run with that `root_run_id`.
- `409 Conflict` — the run exists but already reached a terminal status; the message names which one.
- `409 Conflict` — the run's row says `running` but it is **not executing in this server process**,
  so there is nothing here to abort. Runs are cancellable only from the process running them (spec
  §2), and `.path/path.db` is shared: a `path run` launched from the CLI appears in §3 and §4, and so
  does any run left behind by an earlier crashed process. The route refuses rather than reporting a
  cancel it cannot perform.

Nothing about the run's event stream is special-cased for a cancel — its terminal events (a
`run-cancelled` naming the `operator` cause, then the root's `step-finished`) flow through §5 exactly
as a failure's would.

## 5. `GET /v0/runs/:root_run_id/events` — SSE event stream

`Content-Type: text/event-stream`. Each SSE frame's `data:` payload is one `LogEvent` (the existing
discriminated union in `logging/log-event.ts`), JSON-encoded verbatim — already snake_case at the
envelope level (`run_id`, `node_id`, `seq`, `ts`), so no field translation needed here unlike the
other endpoints.

```
data: {"type":"step-started","seq":1,"ts":"...","run_id":"...","node_id":null,"step_type":"workflow","worker":{...}}

data: {"type":"step-finished","seq":2,"ts":"...","run_id":"...","node_id":"draft","status":"succeeded"}
```

Mechanism: since execution is in-process, the server attaches its own live-forwarding `LogBackend`
(or a third `RunObserver` alongside the existing `composeObservers(createPersistedObserver(...),
createLoggingObserver(...))` pair `cli.ts` already wires) that pushes each event to connected SSE
clients for that `root_run_id` as `runWorkflow` executes — no polling of the db/NDJSON file for
live events.

**Reconnect/replay ([#31](https://github.com/howardyang2009/PATH/issues/31)):** standard SSE
mechanism, not a bespoke one. Each frame carries `id: <seq>`; a client's `EventSource` auto-sends
`Last-Event-ID` on reconnect. Server behavior on connect:

- `Last-Event-ID` header present → replay persisted events with `seq >` that value, then switch to
  live.
- Absent → replay the full history from `seq` 1, then switch to live.

Historical replay reads from the **NDJSON backend** (`run.log`, already ordered by `seq`) — not the
db table, avoiding the read-back query #30 flagged as a gap. **Known v0 limitation:** if a client
disabled the `ndjson` log backend for that run (via `POST /v0/runs`'s `log_backends`), replay is
unavailable — the stream only carries events from connect time onward.

`404 Not Found` if `root_run_id` is unknown. Stream closes (client sees end-of-stream) when the run
reaches a terminal status (`succeeded`/`failed`/`cancelled`) at the root.

## 6. Gaps this ticket surfaces (not blockers, flagged for the assembly ticket)

- `run-store`: add a "list root runs" query (§3).
- ~~No blob-serving endpoint in v0~~ — closed by issue #43: §4.1 serves `input`/`output` content over
  HTTP for clients that are not co-located with the server's filesystem.
- SSE replay depends on the `ndjson` log backend being enabled for the run (§5) — a db-only read-back
  query was considered and dropped in favor of reusing the existing NDJSON file.
