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
- No auth. Localhost-bind only. State-changing routes carry an origin gate against browser CSRF
  (§2.1, #237).
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
| `config` | no | `RunOptions.operatorConfig` — same override semantics as `--config`/`--set`, validated here by `ConfigObjectSchema`. Accepts a literal `{"$secret": "..."}` wrapper (format doc §8.3; masked on the return path). **Rejects** any `{"$env": "NAME"}` wrapper — including the composed `{"$secret": {"$env": "NAME"}}` form — with a `400`: operator override config may not source from the server process environment ([ADR 0012](../adr/0012-operator-config-rejects-env-wrapper.md), server spec §2). An `$env` wrapper authored *inside* a `workflow.json` is unaffected. |
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
- `403 Forbidden` — cross-origin caller, rejected by the origin gate (§2.1) before the body is read.

### 2.1 Origin gate (CSRF, #237)

The server is no-auth, localhost-bind, single-origin (it serves the viewer bundle and this API from
one origin, no CORS headers, #42). The browser launch surface (#228) makes `POST /v0/runs` a
CSRF target: a malicious site the operator has open in another tab can `fetch()` a launch. The
residual threat is the *unwanted launch's side effect*, not exfiltration — the operator's secret is
typed per-launch and never stored, and the same-origin policy blocks reading the response
cross-origin ([ADR 0012](../adr/0012-operator-config-rejects-env-wrapper.md) additionally rejects
`$env` in operator config).

The gate is a header check, no auth (it graduates to token auth if remote access ever lands, §0). It
guards every **state-changing** route — `POST /v0/runs` and `POST /v0/runs/:root_run_id/cancel`
(§4.2) — and rejects with `403` when the request looks like a cross-origin browser call:

- `Sec-Fetch-Site`, when present, is decisive: `same-origin` and `none` (a user-initiated load) pass;
  `cross-site` / `same-site` are refused.
- Absent `Sec-Fetch-Site` (older or non-browser client), fall back to `Origin` vs `Host`: a mismatch
  (or a malformed / `null` `Origin`) is refused; an absent `Origin` passes, since a non-browser
  client (the CLI, curl) sends neither header and is not a CSRF vector.

Read routes (`GET`) are ungated: they have no side effect and the same-origin policy already blocks a
cross-origin page from reading their responses.

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
      "node_name": null,
      "worker": { "...": "..." },
      "status": "succeeded",
      "started_at": "...",
      "finished_at": "...",
      "input_ref": "runs/<root_run_id>/<run_id>/input.json",
      "output_ref": "runs/<root_run_id>/<run_id>/output.json",
      "usage": null,
      "estimated_cost_usd": null,
      "resumed_from_root_run_id": null,
      "reused_from_run_id": null,
      "reused_from_root_run_id": null,
      "workflow_id": "<uuid>",
      "workflow_name": "release-notes",
      "workflow_path": "release-notes.workflow.json"
    }
  ]
}
```

- Top-level `status`/`output` mirror the root row (first entry of `runs`, `parent_run_id: null`) —
  duplicated at the top for a client that only wants the summary.
- `workflow_id`/`workflow_name`/`workflow_path` carry the producing workflow's source identity
  (ADR 0006, #202) and are **root-only** — non-null on the root row (`parent_run_id: null`), null on
  every nested row. `workflow_path` is relative to the store dir, and null for a server-hosted run
  that supplied no path; the GUID/name still identify it.
- `input_ref`/`output_ref` are the same project-relative blob paths the engine already stores
  (`blobRef`). A co-located client can read them off disk directly; a browser client cannot, so
  issue #43 added the blob route below (§4.1) to serve their content over HTTP.
- `resumed_from_root_run_id` is set only on the root row of a resumed tree — the predecessor's root
  run id (#168). Null on a fresh run and on every nested row.
- **Reuse rows** (#257): a resumed tree records a reused node as a real `succeeded` row carrying
  `reused_from_run_id` — the source run whose recorded work it reuses, direct-to-source (ADR 0001) —
  and `reused_from_root_run_id`, the root of the source's tree. Both are null on a genuinely-executed
  row. The row owns no blobs of its own, but its `input_ref`/`output_ref` are **resolved to the
  source run's blobs** (non-null, addressing `runs/<reused_from_root_run_id>/<reused_from_run_id>/…`),
  so a reuse row reads as a row that *has* input/output rather than one with none, and §4.1 serves
  that content by following the pointer. A source tree since removed by `runs rm` leaves both
  `reused_from_root_run_id` and the two refs null — the reused data is genuinely gone.
- `404 Not Found` if `root_run_id` is unknown.

### 4.1 `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — one run's input or output object

Added by issue #43 for browser clients, which cannot read `input_ref`/`output_ref` off the server's
filesystem. `name` is a fixed enum — `input` or `output` — never a raw filename, so the path cannot
escape the run's blob directory. Response `200 OK` with the blob's content as `application/json`,
verbatim: blobs are already secret-masked on disk (masking happens at the persistence boundary), so
the route serves what it reads.

- `404 Not Found` if `root_run_id` is unknown, `run_id` is not in that root's tree, `name` is not a
  served blob, or the blob file is absent (a run has no output until it finishes).
- For a **reuse row** (§4), the route follows `reused_from_run_id` to the source run's tree and serves
  that run's blob — so a reused node returns the reused content, not a `404`. A source tree since
  removed resolves to `404` like any absent blob.
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
- `403 Forbidden` — cross-origin caller, rejected by the origin gate (§2.1); a cancel is a
  state-changing action and is guarded like `POST /v0/runs`.
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

### 4.3 `POST /v0/runs/:root_run_id/resume` — resume a finished-but-unsuccessful run

Re-runs a `cancelled` or `failed` root run as a **successor** (ADR 0001, engine
[#173](https://github.com/howardyang2009/PATH/issues/173)) — the browser counterpart of
`path run <workflow.json> --resume <root-run-id>`. A named action on an existing run, like §4.2, and
async like §2: it answers `202` with the successor's *own* fresh ids the moment it starts, then the
client watches that new run over §5 to its terminal status.

**Optional request body — a `config` override only:**

```json
{ "config": { "output_file": "RELEASE_NOTES_v2.md" } }
```

The workflow file to re-run is recovered from the predecessor's own row (`workflow_path`, recorded on
every launch since engine #169), so a resume names *which run* to continue, not what to run. The one
thing the caller may supply is a `config` override, validated by `ConfigObjectSchema` and carrying
the same `$env` reject as §2 ([ADR 0012](../adr/0012-operator-config-rejects-env-wrapper.md)): the
engine applies operator config on the resume path too (it shadows the workflow's declared config, key
by key, for the steps that re-run), so an operator can change a value — an output path, a range —
before continuing. There is **no `input`**: a resumed run restores its context from the predecessor's
tree (engine `cli.ts`), so a fresh input seed would be silently discarded. Omitting the body (or
sending none) resumes with the workflow's own declared config. The successor records its own
`workflow_path` and is therefore itself resumable.

Responses:

- `202 Accepted` — the successor started:
  ```json
  { "run_id": "<successor-uuid>", "root_run_id": "<successor-uuid>" }
  ```
  The ids are the **successor's**, never the predecessor's; the successor's root row carries
  `resumed_from_root_run_id` pointing back (§4 tree, §3 list).
- `403 Forbidden` — cross-origin caller (the §2.1 origin gate; resume is state-changing).
- `404 Not Found` — no run with that `root_run_id`, or its recorded `workflow_path` no longer exists
  on disk.
- `400 Bad Request` — a malformed body, a `config` override that fails `ConfigObjectSchema` or carries
  an `$env` wrapper (ADR 0012), or a workflow file that was found but no longer passes validation
  (`error.details` carries the issues), exactly as a fresh launch of it would.
- `409 Conflict` — the run is not in a resumable state, each case named distinctly: still `running`
  (nothing to resume yet), already `succeeded` (nothing to resume), it carries no recorded
  `workflow_path` (a pre-#169 run) so the server cannot know which file to re-run, or the file now at
  that path is a **different workflow** (its `id` no longer matches the run's, ADR 0006) — the path
  is recovered from the row, not re-confirmed by the operator, so a swapped file is refused rather
  than run against the predecessor's restored context.

## 5. `GET /v0/runs/:root_run_id/events` — SSE event stream

`Content-Type: text/event-stream`. Each SSE frame's `data:` payload is one `LogEvent` (the existing
discriminated union in `logging/log-event.ts`), JSON-encoded verbatim — already snake_case at the
envelope level (`run_id`, `node_id`, `seq`, `ts`), so no field translation needed here unlike the
other endpoints.

```
data: {"type":"step-started","seq":1,"ts":"...","run_id":"...","node_id":null,"node_name":null,"step_type":"workflow","worker":{...}}

data: {"type":"step-finished","seq":2,"ts":"...","run_id":"...","node_id":"<uuid>","node_name":"draft","status":"succeeded"}
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

## 6. `GET /v0/workflows` — discover launchable workflows

New capability ([#230](https://github.com/howardyang2009/PATH/issues/230), part of
[#228](https://github.com/howardyang2009/PATH/issues/228)). Scans the server's fixed project root
for workflow files and returns them, each flagged whether it is a **root** (referenced by no other
discovered workflow) or also reachable as a nested `workflow` ref. Pure read — no new engine exec
path.

**Scan.** Recursively collect every `*.workflow.json` under the project root (the repo convention;
there is no bare `workflow.json`). Skip `.path/`, `node_modules`, and any directory whose name
starts with `.`. Symlinks are **not** followed — the loader canonicalizes lexically (`resolve`, not
`realpath`), and matching that avoids aliasing a nested file as a root
([valid-root-detection.md](../research/valid-root-detection.md)).

**Root classification.** For each discovered file, `loadWorkflowTree(f)`; on success subtract that
tree's nested-ref set — `keys(tree.files) \ {rootPath}` — from the discovered union. A file landing
in *any* successfully-loaded root's nested set is `is_root: false`; a file no valid workflow
references is `is_root: true`; a file whose own load fails cannot be classified → `is_root: null`
(a failed `LoadResult` carries no `tree.files`). The subtraction is sound because refs are
schema-guaranteed relative paths (valid-root-detection.md §3).

**Every discovered file is listed** — nested refs included, not deduped away. A nested-ref target is
itself a complete, schema-valid workflow (workflow-as-step, CONTEXT.md) and is independently
launchable via §2 with operator-supplied `input` + `config`; `is_root` is a presentation/dedupe
hint, **not** a launchability gate. This reverses the "valid-roots-only" scoping first charted in
#228 — see [ADR 0011](../adr/0011-discovery-lists-all-workflows-roots-flagged.md).

Response `200 OK`:

```json
{
  "workflows": [
    {
      "relative_path": "release-notes.workflow.json",
      "id": "<uuid>",
      "name": "release-notes",
      "valid": true,
      "is_root": true,
      "error": null
    },
    {
      "relative_path": "lib/draft.workflow.json",
      "id": "<uuid>",
      "name": "draft",
      "valid": true,
      "is_root": false,
      "error": null
    },
    {
      "relative_path": "broken.workflow.json",
      "id": null,
      "name": null,
      "valid": false,
      "is_root": null,
      "error": { "message": "unexpected token in JSON at position 12", "details": "..." }
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `relative_path` | string | Path relative to the project root — the **exact string** a client feeds back as §2 `workflow_path` (same resolution). The launch handle. |
| `id` | string \| null | The workflow's source-identity GUID (top-level `id`, ADR 0006). Best-effort shallow-parsed for an invalid file so the list stays human-legible; `null` when even the top-level parse fails. |
| `name` | string \| null | The workflow's human `name` (same best-effort rule as `id`). |
| `valid` | boolean | `loadWorkflowTree(f).success` — a static load + schema/ref/cycle validate that never executes a step. |
| `is_root` | boolean \| null | `true` unreferenced; `false` reachable as another discovered workflow's nested ref; `null` when `valid: false`. |
| `error` | object \| null | The shared error shape (§1) when `valid: false` (bad JSON, schema violation, missing ref, cycle); `null` otherwise. |

- **No input hint.** The format declares no input schema (top-level `WorkflowFileSchema` carries
  `format`/`id`/`name`/`worker`/`config`/`body`/`output`, no `input`), so an entry says nothing
  about what `input` a launch needs — the operator supplies it as raw JSON (#228). An inner
  workflow's *effective config* (invariant 5: config inherits downward) is likewise not surfaced:
  **schema-valid ≠ self-sufficient standalone.** Discovery reports existence, validity, and
  root-ness only — never launch-readiness.
- **Synchronous `200`, fresh scan each call** — no pagination, no `limit`, no cache. An operator
  adds files between calls and staleness is worse than a re-scan. Designed for a project root
  holding tens–low-hundreds of workflow files, not a monorepo-wide index; loading every candidate to
  classify roots is the cost driver and bounds the scale. Shared children dedupe by absolute-path key
  within one tree load but are re-read across sibling roots — acceptable at that scale.

## 7. `PUT /v0/workflows` — write a workflow file

New capability ([#257](https://github.com/howardyang2009/PATH/issues/257), part of
[#254](https://github.com/howardyang2009/PATH/issues/254) — the Designer). `@path/server`'s first
write path for files: every other route reads, or launches/cancels/resumes a run. One verb serves both
create and overwrite; the resource path travels in the body, not the URL, so a `/`-bearing
`relative_path` needs no `%2F` encoding and resolves the same way `POST /v0/runs` resolves
`workflow_path`. Governing decision: [ADR 0016](../adr/0016-workflow-write-route-client-named-put-upsert-precondition-gated.md).

**Origin-gated.** State-changing, so it passes the §2.1 origin gate before the body is read — a
cross-origin browser call is `403` (same CSRF reasoning as `POST /v0/runs`).

Request body:

```json
{
  "workflow_path": "lib/draft.workflow.json",
  "workflow": { "format": "...", "id": "<uuid>", "name": "draft", "...": "..." }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `workflow_path` | yes | Path to the file to write, relative to the server's fixed project root — the **exact string** discovery returns as `relative_path` (§6), same resolution as §2 `workflow_path`. |
| `workflow` | yes | The workflow object, snake_case wire (§1). The server serializes it deterministically (`JSON.stringify(wf, null, 2)` + trailing newline, author key order preserved) and owns the on-disk bytes. |

**Precondition (concurrency) is an HTTP conditional header, not a body field.** The single-file read
(§7.1) hands back a strong `ETag`; the write reads intent from the header:

- **no `If-Match`** → **create-only**: `412` if the file already exists;
- **`If-Match: <etag>`** → **overwrite-only**: `412` if the on-disk bytes changed or the file is gone.

There is no spelling for a blind last-writer-wins overwrite — every overwrite must present a matching
ETag. #258's edit lease is politeness; this precondition is what protects the bytes.

**Validation is single-file, not tree-wide.** The route runs `@path/schema` (`WorkflowFileSchema`) plus
a whole-file duplicate-`id` check, and confines the path. It does **not** run `loadWorkflowTree`: a
saved file may reference a nested `workflow` not yet on disk (a WIP save, or a parent saved before its
child). Ref resolution and cycle detection stay at launch (§2). A written file is thus schema-valid but
not necessarily launch-ready — the §6 "schema-valid ≠ self-sufficient" asymmetry.

- The **duplicate-`id`** check is one flat namespace over the whole file: the workflow's own `id`, every
  node, every `parallel` branch, every branch arm, and the `else` — the same scope `name` uniqueness
  already uses. Per [#256](https://github.com/howardyang2009/PATH/issues/256) this check lives in
  `@path/schema`, so a duplicate-id body fails schema validation and is covered by the existing `400`
  with no separate code path. `error.details` **names both offending paths**, not a bare "duplicate id":
  a Designer must mark the canvas and a hand-rolled client must find the line.
- The route is **identity-agnostic** (ADR 0015): it validates the incoming `id` *shape* but never stamps
  a missing `id`, never re-mints, and never diffs against the file on disk.

Checks run in order — cheapest and security-first before the disk is touched: origin gate → body is
valid JSON → envelope schema → path confine/symlink → workflow schema + dup-id → precondition → write.

Responses:

- `201 Created` — a new file was written; `200 OK` — an existing file was overwritten. Body carries the
  new ETag so the client needs no follow-up `GET`:
  ```json
  { "relative_path": "lib/draft.workflow.json", "id": "<uuid>", "etag": "\"<sha256-hex>\"" }
  ```
  The same value is returned in the `ETag` response header.
- `400 Bad Request` — body is not valid JSON, envelope is malformed (`workflow_path` missing/empty,
  `workflow` absent), or `workflow` fails `@path/schema` (including a duplicate `id`, or an absent `id`).
  `error.details` carries the validation issues.
- `404 Not Found` — `workflow_path` resolves outside the project root, or any component of the resolved
  path is a symlink. The write refuses to *traverse* a symlink (per-component check), a stronger stance
  than discovery's, which only refuses to *list* one — a symlinked parent directory could otherwise
  redirect the write outside the root even when the lexical path stays inside.
- `403 Forbidden` — cross-origin caller, rejected by the origin gate (§2.1) before the body is read.
- `412 Precondition Failed` — the conditional header did not hold: `If-Match` mismatch (the file changed
  or is gone), or a create-only write (no `If-Match`) against a path that already exists.

### 7.1 `GET /v0/workflows/file?path=<relative_path>` — read one workflow file (raw)

The read side the precondition needs, and the ADR 0015 handoff the Designer needs. A `GET` carries no
body, so the path rides a query param — still an opaque `/`-bearing string, no `%2F` router split.

**Always raw.** Streams the file bytes verbatim and returns a strong `ETag` (sha256 of those bytes); it
**never runs the loader**. That is deliberate: (a) the ETag must hash the exact on-disk bytes anyway;
(b) the Designer needs the raw body to preserve unknown fields and to receive an **id-less** file so it
can stamp ids on import (ADR 0015); (c) validation already has homes — discovery reports `valid`/`error`
(§6) and the write route validates inbound. A re-validating read would duplicate that and would break
the id-less handoff.

This makes the read/write pair asymmetric on purpose: **`GET` is lenient** (serves an id-less file),
**`PUT` is strict** (an id-less body is a `400`, since `@path/schema` requires ids). The Designer mints
ids client-side into its dirty buffer and always saves an id-bearing file. Discovery, which *does* run
`loadWorkflowTree`, keeps reporting an on-disk id-less file as `valid: false` — not a contradiction:
discovery reports launch-validity, this route reports bytes.

Responses:

- `200 OK` — `Content-Type: application/json`, body is the file's raw bytes, `ETag` header set.
- `404 Not Found` — file does not exist, `path` escapes the project root, or a path component is a
  symlink (same confinement as §7).
- `403 Forbidden` — a `GET` is ungated (§2.1), so this arises only if a future auth layer lands; listed
  for shape-parity, not emitted today.

## 8. Gaps this ticket surfaces (not blockers, flagged for the assembly ticket)

- `run-store`: add a "list root runs" query (§3).
- Discovery (§6) needs one additive helper: a directory scan + per-file `loadWorkflowTree`
  classification. The loader primitives already exist (`tree.files` is the transitive nested-ref set,
  valid-root-detection.md §1); the scan + set-subtraction lives in `@path/server`, no engine change.
- ~~No blob-serving endpoint in v0~~ — closed by issue #43: §4.1 serves `input`/`output` content over
  HTTP for clients that are not co-located with the server's filesystem.
- SSE replay depends on the `ndjson` log backend being enabled for the run (§5) — a db-only read-back
  query was considered and dropped in favor of reusing the existing NDJSON file.
