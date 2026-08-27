# PATH Server API v0 — Endpoint Surface

This spec resolves wayfinder ticket [#30](https://github.com/howardyang2009/PATH/issues/30), part of
[Wayfinder map: PATH server API](https://github.com/howardyang2009/PATH/issues/29). This document is
the normative definition of the `@path/server` v0 HTTP contract. The vocabulary follows
[CONTEXT.md](../../CONTEXT.md). Sibling tickets own the server lifecycle/CLI surface and the SSE
reconnect/replay semantics ([#33](https://github.com/howardyang2009/PATH/issues/33),
[#31](https://github.com/howardyang2009/PATH/issues/31)). This document fixes the endpoint list and the
request/response shapes.

**Versioning ([#32](https://github.com/howardyang2009/PATH/issues/32)):** path-prefixed. It mirrors the
workflow format's self-declaring `path/workflow@0`. Every endpoint below lives under `/v0`. A breaking
change to the contract ships as `/v1` alongside it, never a silent reshape of `/v0`.

## 0. Constraints (from the map, not re-litigated here)

- Transport: HTTP + SSE only. No WebSocket, no raw IPC socket.
- `@path/server` is a new package. It imports `@path/engine` **in-process** (`runWorkflow`,
  `loadWorkflowTree`, log backends). It is not a CLI subprocess wrapper.
- No auth. Localhost-bind only. State-changing routes carry an origin gate against browser CSRF (§2.1,
  #237).
- One fixed project root per server instance, set at startup. It is one `.path/` tree, like `path run`.
- Multiple root runs may execute concurrently. There is no server-side queueing.
- Cancellation is **best-effort and root-only** (mvp spec §5.6), because that is exactly what the
  engine's external abort ([#52](https://github.com/howardyang2009/PATH/issues/52)) delivers. The
  server does not promise more than the engine does. There is no force/kill escalation, no timeout, and
  no route to cancel a nested run or a single step. The endpoint is §4.2.

## 1. Conventions

- All request and response bodies are JSON, `Content-Type: application/json`.
- **Field casing is snake_case.** This matches the existing wire conventions in this codebase (the
  log-event envelope's `run_id` and `node_id`, the format's `max_iterations`). It does not match the
  camelCase used internally in `RunRecord` and `RunResult`. The server translates at the boundary.
- Errors share one shape:
  ```json
  { "error": { "message": "human-readable summary", "details": "<optional>" } }
  ```
  `details` carries structured data where available (for example, zod validation issues from
  `loadWorkflowTree`). Otherwise it is omitted.
- A `root_run_id` always equals its own `run_id` for a root run. The two ever diverge only for non-root
  rows returned inside a run tree (§3).

## 2. `POST /v0/runs` — start a run

Async only (locked decision). It returns as soon as the run is accepted and validated, before execution
finishes. The client polls `GET /v0/runs/:root_run_id` or streams `GET /v0/runs/:root_run_id/events`.

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
field, then `.path/settings.json`, then built-in default** (mvp spec §9). Before #64 the server ignored
the settings file. So an operator who had configured one saw it apply to `path run` and not to the API.
A malformed settings file now fails server startup rather than being silently skipped. This matches how
`path run` refuses to start.

Responses:

- `202 Accepted` — the workflow tree loaded and validated, and the run started:
  ```json
  { "run_id": "<uuid>", "root_run_id": "<uuid>" }
  ```
  (`run_id` and `root_run_id` are always equal here. The field is duplicated for shape-parity with
  `GET /v0/runs` and `GET /v0/runs/:id`, which both return the same envelope for non-root run rows.)
- `400 Bad Request` — `workflow_path` missing or not found, or a `loadWorkflowTree` validation failure.
  `error.details` carries the validation issues.
- `404 Not Found` — `workflow_path` resolves outside the project root, or the file does not exist.
- `403 Forbidden` — a cross-origin caller, rejected by the origin gate (§2.1) before the body is read.

### 2.1 Origin gate (CSRF, #237)

The server is no-auth, localhost-bind, single-origin (it serves the viewer bundle and this API from one
origin, no CORS headers, #42). The browser launch surface (#228) makes `POST /v0/runs` a CSRF target: a
malicious site that the operator has open in another tab can `fetch()` a launch. The residual threat is
the *unwanted launch's side effect*, not exfiltration. The operator's secret is typed per-launch and
never stored, and the same-origin policy blocks a read of the response cross-origin
([ADR 0012](../adr/0012-operator-config-rejects-env-wrapper.md) additionally rejects `$env` in operator
config).

The gate is a header check, no auth (it graduates to token auth if remote access ever lands, §0). It
guards every **state-changing** route (`POST /v0/runs` and `POST /v0/runs/:root_run_id/cancel`, §4.2).
It rejects with `403` when the request looks like a cross-origin browser call:

- `Sec-Fetch-Site`, when present, is decisive. `same-origin` and `none` (a user-initiated load) pass.
  `cross-site` and `same-site` are refused.
- With `Sec-Fetch-Site` absent (an older or non-browser client), fall back to `Origin` vs `Host`. A
  mismatch (or a malformed or `null` `Origin`) is refused. An absent `Origin` passes, because a
  non-browser client (the CLI, curl) sends neither header and is not a CSRF vector.

Read routes (`GET`) are ungated. They have no side effect, and the same-origin policy already blocks a
cross-origin page from a read of their responses.

## 3. `GET /v0/runs` — list root runs

New capability. The engine has no "list root runs" query today (`getRunsForRoot` requires a known
`root_run_id`). It requires one small additive `run-store` function: root runs are exactly the rows
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

Most recent first (`ORDER BY started_at DESC`). This is the root-run summary shape only. It has no
`output`, `usage`, or full tree; fetch `GET /v0/runs/:root_run_id` for that.

## 4. `GET /v0/runs/:root_run_id` — run status + tree

Response `200 OK`, one row per `RunRecord` in the tree (`getRunsForRoot`, camelCase fields translated to
snake_case):

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

- The top-level `status` and `output` mirror the root row (the first entry of `runs`,
  `parent_run_id: null`). They are duplicated at the top for a client that only wants the summary.
- `workflow_id`, `workflow_name`, and `workflow_path` carry the producing workflow's source identity
  (ADR 0006, #202). They are **root-only**: non-null on the root row (`parent_run_id: null`), null on
  every nested row. `workflow_path` is relative to the store dir, and null for a server-hosted run that
  supplied no path; the GUID and name still identify it.
- `input_ref` and `output_ref` are the same project-relative blob paths the engine already stores
  (`blobRef`). A co-located client can read them off disk directly. A browser client cannot, so issue
  #43 added the blob route below (§4.1) to serve their content over HTTP.
- `resumed_from_root_run_id` is set only on the root row of a resumed tree. It is the predecessor's root
  run id (#168). It is null on a fresh run and on every nested row.
- **Reuse rows** (#257): a resumed tree records a reused node as a real `succeeded` row. It carries
  `reused_from_run_id`, the source run whose recorded work it reuses, direct-to-source (ADR 0001), and
  `reused_from_root_run_id`, the root of the source's tree. Both are null on a genuinely-executed row.
  The row owns no blobs of its own. But its `input_ref` and `output_ref` are **resolved to the source
  run's blobs** (non-null, addressing `runs/<reused_from_root_run_id>/<reused_from_run_id>/…`). Thus a
  reuse row reads as a row that *has* input and output rather than one with none, and §4.1 serves that
  content by a follow of the pointer. If a source tree was since removed by `runs rm`, both
  `reused_from_root_run_id` and the two refs are null; the reused data is genuinely gone.
- `404 Not Found` if `root_run_id` is unknown.

### 4.1 `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — one run's input, output, or context object

Added by issue #43 for browser clients, which cannot read `input_ref` and `output_ref` off the server's
filesystem. `name` is a fixed enum (`input`, `output`, or `context`, #297), never a raw filename, so the
path cannot escape the run's blob directory. Response `200 OK` with the blob's content as
`application/json`, verbatim. Blobs are already secret-masked on disk (masking happens at the
persistence boundary), so the route serves what it reads.

- `404 Not Found` if `root_run_id` is unknown, `run_id` is not in that root's tree, `name` is not a
  served blob, or the blob file is absent (a run has no output until it finishes).
- For a **reuse row** (§4), the route follows `reused_from_run_id` to the source run's tree and serves
  that run's blob. Thus a reused node returns the reused content, not a `404`. A source tree since
  removed resolves to `404` like any absent blob.
- `context` is served (#297): a workflow-run's `context.json` blackboard, and a leaf step's snapshot of
  that context as it stood when the step finished. Only a workflow-run and a finished leaf step write
  one. So a `context` read for a run that recorded none is an absent blob, which gives `404`.
- `stderr` blobs are deferred (map #40). The name resolves as unknown.

### 4.2 `POST /v0/runs/:root_run_id/cancel` — stop a root run in flight

Added by issue [#54](https://github.com/howardyang2009/PATH/issues/54), once the engine could be aborted
from outside ([#52](https://github.com/howardyang2009/PATH/issues/52)). It is a **named action**, not a
mutation of a status field and not a `DELETE`. `DELETE` keeps the meaning "remove the record" if it ever
ships, and the run record is the audit trail, which must survive a cancel. No request body.

Root runs only, and best-effort. It signals the abort the engine already understands. It adds no force
path and no deadline of its own (§0).

Responses:

- `202 Accepted` — the abort was **signalled**:
  ```json
  { "root_run_id": "<uuid>" }
  ```
  Like `POST /v0/runs` (§2), the response goes out before the run finishes. An in-flight SDK turn can
  take seconds to unwind, and there is no bound to hang a request on. The client learns the real
  terminal status from the SSE stream (§5) it is already watching, or by a poll of §4, not from this
  response. The status enum is unchanged. There is no `cancelling` status on the wire or in the db, so a
  client that wants to show the unwind window holds that state locally.

  To repeat the call while the run is still unwinding answers `202` again. To abort an already-aborted
  run is a no-op, so a double click is safe.
- `403 Forbidden` — a cross-origin caller, rejected by the origin gate (§2.1). A cancel is a
  state-changing action and is guarded like `POST /v0/runs`.
- `404 Not Found` — no run with that `root_run_id`.
- `409 Conflict` — the run exists but already reached a terminal status. The message names which one.
- `409 Conflict` — the run's row says `running`, but it is **not executing in this server process**, so
  there is nothing here to abort. Runs are cancellable only from the process that runs them (spec §2),
  and `.path/path.db` is shared. A `path run` launched from the CLI appears in §3 and §4, and so does
  any run left behind by an earlier crashed process. The route refuses rather than report a cancel it
  cannot perform.

Nothing about the run's event stream is special-cased for a cancel. Its terminal events (a
`run-cancelled` naming the `operator` cause, then the root's `step-finished`) flow through §5 exactly as
a failure's would.

### 4.3 `POST /v0/runs/:root_run_id/resume` — resume a finished-but-unsuccessful run

Re-runs a `cancelled` or `failed` root run as a **successor** (ADR 0001, engine
[#173](https://github.com/howardyang2009/PATH/issues/173)). It is the browser counterpart of
`path run <workflow.json> --resume <root-run-id>`. It is a named action on an existing run, like §4.2,
and async like §2. It answers `202` with the successor's *own* fresh ids the moment it starts. Then the
client watches that new run over §5 to its terminal status.

**Optional request body — a `config` override only:**

```json
{ "config": { "output_file": "RELEASE_NOTES_v2.md" } }
```

The workflow file to re-run is recovered from the predecessor's own row (`workflow_path`, recorded on
every launch since engine #169). So a resume names *which run* to continue, not what to run. The one
thing the caller may supply is a `config` override, validated by `ConfigObjectSchema` and carrying the
same `$env` reject as §2 ([ADR 0012](../adr/0012-operator-config-rejects-env-wrapper.md)). The engine
applies operator config on the resume path too (it shadows the workflow's declared config, key by key,
for the steps that re-run). Thus an operator can change a value (an output path, a range) before the
continue. There is **no `input`**: a resumed run restores its context from the predecessor's tree
(engine `cli.ts`), so a fresh input seed would be silently discarded. To omit the body (or send none)
resumes with the workflow's own declared config. The successor records its own `workflow_path` and is
therefore itself resumable.

Responses:

- `202 Accepted` — the successor started:
  ```json
  { "run_id": "<successor-uuid>", "root_run_id": "<successor-uuid>" }
  ```
  The ids are the **successor's**, never the predecessor's. The successor's root row carries
  `resumed_from_root_run_id` that points back (§4 tree, §3 list).
- `403 Forbidden` — a cross-origin caller (the §2.1 origin gate; resume is state-changing).
- `404 Not Found` — no run with that `root_run_id`, or its recorded `workflow_path` no longer exists on
  disk.
- `400 Bad Request` — a malformed body, a `config` override that fails `ConfigObjectSchema` or carries
  an `$env` wrapper (ADR 0012), or a workflow file that was found but no longer passes validation
  (`error.details` carries the issues), exactly as a fresh launch of it would.
- `409 Conflict` — the run is not in a resumable state, each case named distinctly: still `running`
  (nothing to resume yet); already `succeeded` (nothing to resume); it carries no recorded
  `workflow_path` (a pre-#169 run), so the server cannot know which file to re-run; or the file now at
  that path is a **different workflow** (its `id` no longer matches the run's, ADR 0006). The path is
  recovered from the row, not re-confirmed by the operator, so a swapped file is refused rather than run
  against the predecessor's restored context.

## 5. `GET /v0/runs/:root_run_id/events` — SSE event stream

`Content-Type: text/event-stream`. Each SSE frame's `data:` payload is one `LogEvent` (the existing
discriminated union in `logging/log-event.ts`), JSON-encoded verbatim. It is already snake_case at the
envelope level (`run_id`, `node_id`, `seq`, `ts`), so no field translation is needed here, unlike the
other endpoints.

```
data: {"type":"step-started","seq":1,"ts":"...","run_id":"...","node_id":null,"node_name":null,"step_type":"workflow","worker":{...}}

data: {"type":"step-finished","seq":2,"ts":"...","run_id":"...","node_id":"<uuid>","node_name":"draft","status":"succeeded"}
```

Mechanism: execution is in-process, so the server attaches its own live-forwarding `LogBackend` (or a
third `RunObserver` alongside the existing `composeObservers(createPersistedObserver(...),
createLoggingObserver(...))` pair that `cli.ts` already wires). It pushes each event to connected SSE
clients for that `root_run_id` as `runWorkflow` executes. There is no poll of the db or NDJSON file for
live events.

**Reconnect/replay ([#31](https://github.com/howardyang2009/PATH/issues/31)):** the standard SSE
mechanism, not a bespoke one. Each frame carries `id: <seq>`. A client's `EventSource` auto-sends
`Last-Event-ID` on reconnect. Server behavior on connect:

- With the `Last-Event-ID` header present, replay persisted events with `seq >` that value, then switch
  to live.
- With it absent, replay the full history from `seq` 1, then switch to live.

Historical replay reads from the **NDJSON backend** (`run.log`, already ordered by `seq`), not the db
table. This avoids the read-back query that #30 flagged as a gap. **Known v0 limitation:** if a client
disabled the `ndjson` log backend for that run (via `POST /v0/runs`'s `log_backends`), replay is
unavailable. The stream only carries events from connect time onward.

`404 Not Found` if `root_run_id` is unknown. The stream closes (the client sees end-of-stream) when the
run reaches a terminal status (`succeeded`/`failed`/`cancelled`) at the root.

## 6. `GET /v0/workflows` — discover launchable workflows

New capability ([#230](https://github.com/howardyang2009/PATH/issues/230), part of
[#228](https://github.com/howardyang2009/PATH/issues/228)). It scans the server's fixed project root for
workflow files and returns them. It flags each whether it is a **root** (referenced by no other
discovered workflow) or also reachable as a nested `workflow` ref. It is a pure read, with no new engine
exec path.

**Scan.** Recursively collect every `*.workflow.json` under the project root (the repo convention; there
is no bare `workflow.json`). Skip `.path/`, `node_modules`, and any directory whose name starts with
`.`. Symlinks are **not** followed. The loader canonicalizes lexically (`resolve`, not `realpath`), and
a match of that avoids the alias of a nested file as a root
([valid-root-detection.md](../research/valid-root-detection.md)).

**Root classification.** For each discovered file, run `loadWorkflowTree(f)`. On success, subtract that
tree's nested-ref set (`keys(tree.files) \ {rootPath}`) from the discovered union. A file that lands in
*any* successfully-loaded root's nested set is `is_root: false`. A file that no valid workflow
references is `is_root: true`. A file whose own load fails cannot be classified, so `is_root: null` (a
failed `LoadResult` carries no `tree.files`). The subtraction is sound, because refs are
schema-guaranteed relative paths (valid-root-detection.md §3).

**Every discovered file is listed** — nested refs included, not deduped away. A nested-ref target is
itself a complete, schema-valid workflow (workflow-as-step, CONTEXT.md). It is independently launchable
via §2 with operator-supplied `input` and `config`. `is_root` is a presentation/dedupe hint, **not** a
launchability gate. This reverses the "valid-roots-only" scoping first charted in #228. See
[ADR 0011](../adr/0011-discovery-lists-all-workflows-roots-flagged.md).

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
| `valid` | boolean | `loadWorkflowTree(f).success` — a static load + schema/ref/cycle validate that never executes a step. It is **registry-relative**: a file naming a step type this tree holds no plugin for is `false`. |
| `is_root` | boolean \| null | `true` unreferenced; `false` reachable as another discovered workflow's nested ref; `null` when `valid: false`. |
| `error` | object \| null | The shared error shape (§1) when `valid: false` (bad JSON, schema violation, missing ref, cycle, unknown step type, broken plugin folder); `null` otherwise. |

- **A file whose step-type plugin is absent is `valid: false`, not valid-but-unlaunchable**
  ([#315](https://github.com/howardyang2009/PATH/issues/315)). The set of valid leaf step types is a fact
  about the **step-plugin registry** this tree loaded, not about the format
  ([ADR 0019](../adr/0019-step-plugins-are-folders-under-packages-engine-step-plugins.md),
  [workflow-format-v2.md](../format/workflow-format-v2.md) §4). So a file naming `api-call` where no
  `api-call` plugin folder exists is invalid **against the only registry this server has**, and `valid`
  reports exactly that. No `launchable` field is added: §6 has never reported launch-readiness (see the
  bullet below and ADR 0011), and a valid-but-unlaunchable state would need the loader to gain a
  partial-success mode — the third registry state ADR 0019 sub-decision 16 declined. The `error` names
  every missing type in one message, plus the `packages/engine/step-plugins/<name>/` folder that would
  supply it (ADR 0018 sub-decision 5, as amended), so one call tells a client the whole list of what this
  tree lacks. Since a workflow file carries no `requires` block, that message *is* the dependency report.
- **One broken plugin folder invalidates the whole list.** A candidate folder with no `index.ts`, a
  throwing import, or a malformed export is a hard load failure for *every* workflow, including files
  that never name it (ADR 0019 sub-decision 16). Because §6 calls `loadWorkflowTree` once per discovered
  file, every entry then reads `valid: false, is_root: null` with the same folder-naming `error`. This is
  legible but repetitive, and it is the accepted cost of PATH failing loudly at load.
- **No input hint.** The format declares no input schema (the top-level `WorkflowFileSchema` carries
  `format`, `id`, `name`, `worker`, `config`, `body`, and `output`, no `input`). So an entry says
  nothing about what `input` a launch needs; the operator supplies it as raw JSON (#228). An inner
  workflow's *effective config* (invariant 5: config inherits downward) is likewise not surfaced.
  **Schema-valid does not equal self-sufficient standalone.** Discovery reports existence, validity, and
  root-ness only, never launch-readiness.
- **Synchronous `200`, fresh scan each call.** There is no pagination, no `limit`, and no cache. An
  operator adds files between calls, and staleness is worse than a re-scan. It is designed for a project
  root that holds tens to low-hundreds of workflow files, not a monorepo-wide index. To load every
  candidate to classify roots is the cost driver, and it bounds the scale. Shared children dedupe by
  absolute-path key within one tree load, but are re-read across sibling roots. This is acceptable at
  that scale.

## 7. `PUT /v0/workflows` — write a workflow file

New capability ([#257](https://github.com/howardyang2009/PATH/issues/257), part of
[#254](https://github.com/howardyang2009/PATH/issues/254), the Designer). It is `@path/server`'s first
write path for files. Every other route reads, or launches, cancels, or resumes a run. One verb serves
both create and overwrite. The resource path travels in the body, not the URL, so a `/`-bearing
`relative_path` needs no `%2F` encoding and resolves the same way `POST /v0/runs` resolves
`workflow_path`. Governing decision:
[ADR 0016](../adr/0016-workflow-write-route-client-named-put-upsert-precondition-gated.md).

**Origin-gated.** It is state-changing, so it passes the §2.1 origin gate before the body is read. A
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

**The precondition (concurrency) is an HTTP conditional header, not a body field.** The single-file read
(§7.1) hands back a strong `ETag`. The write reads intent from the header:

- **no `If-Match`** means **create-only**: `412` if the file already exists.
- **`If-Match: <etag>`** means **overwrite-only**: `412` if the on-disk bytes changed or the file is
  gone.

There is no spelling for a blind last-writer-wins overwrite. Every overwrite must present a matching
ETag. #258's edit lease is politeness. This precondition is what protects the bytes.

**Validation is single-file, not tree-wide.** The route runs `@path/schema` (`WorkflowFileSchema`) plus
a whole-file duplicate-`id` check, and it confines the path. It does **not** run `loadWorkflowTree`. A
saved file may reference a nested `workflow` not yet on disk (a WIP save, or a parent saved before its
child). Ref resolution and cycle detection stay at launch (§2). Thus a written file is schema-valid but
not necessarily launch-ready — the §6 "schema-valid does not equal self-sufficient" asymmetry.

- The **duplicate-`id`** check is one flat namespace over the whole file: the workflow's own `id`, every
  node, every `parallel` branch, every branch arm, and the `else`. It is the same scope that `name`
  uniqueness already uses. Per [#256](https://github.com/howardyang2009/PATH/issues/256) this check
  lives in `@path/schema`. So a duplicate-id body fails schema validation and is covered by the existing
  `400`, with no separate code path. `error.details` **names both offending paths**, not a bare
  "duplicate id". A Designer must mark the canvas, and a hand-rolled client must find the line.
- The route is **identity-agnostic** (ADR 0015). It validates the incoming `id` *shape*, but never
  stamps a missing `id`, never re-mints, and never diffs against the file on disk.

Checks run in order, cheapest and security-first before the disk is touched: origin gate, then body is
valid JSON, then envelope schema, then path confine/symlink, then workflow schema plus dup-id, then
precondition, then write.

Responses:

- `201 Created` — a new file was written. `200 OK` — an existing file was overwritten. The body carries
  the new ETag, so the client needs no follow-up `GET`:
  ```json
  { "relative_path": "lib/draft.workflow.json", "id": "<uuid>", "etag": "\"<sha256-hex>\"" }
  ```
  The same value is returned in the `ETag` response header.
- `400 Bad Request` — the body is not valid JSON, the envelope is malformed (`workflow_path` missing or
  empty, `workflow` absent), or `workflow` fails `@path/schema` (including a duplicate `id`, or an
  absent `id`). `error.details` carries the validation issues.
- `404 Not Found` — `workflow_path` resolves outside the project root, or any component of the resolved
  path is a symlink. The write refuses to *traverse* a symlink (a per-component check), a stronger
  stance than discovery's, which only refuses to *list* one. A symlinked parent directory could
  otherwise redirect the write outside the root even when the lexical path stays inside.
- `403 Forbidden` — a cross-origin caller, rejected by the origin gate (§2.1) before the body is read.
- `412 Precondition Failed` — the conditional header did not hold: an `If-Match` mismatch (the file
  changed or is gone), or a create-only write (no `If-Match`) against a path that already exists.

### 7.1 `GET /v0/workflows/file?path=<relative_path>` — read one workflow file (raw)

This is the read side the precondition needs, and the ADR 0015 handoff the Designer needs. A `GET`
carries no body, so the path rides a query param. It is still an opaque `/`-bearing string, no `%2F`
router split.

**Always raw.** It streams the file bytes verbatim and returns a strong `ETag` (sha256 of those bytes).
It **never runs the loader**. That is deliberate. (a) The ETag must hash the exact on-disk bytes anyway.
(b) The Designer needs the raw body to preserve unknown fields and to receive an **id-less** file, so it
can stamp ids on import (ADR 0015). (c) Validation already has homes: discovery reports `valid`/`error`
(§6), and the write route validates inbound. A re-validating read would duplicate that, and it would
break the id-less handoff.

This makes the read/write pair asymmetric on purpose: **`GET` is lenient** (it serves an id-less file),
**`PUT` is strict** (an id-less body is a `400`, because `@path/schema` requires ids). The Designer
mints ids client-side into its dirty buffer and always saves an id-bearing file. Discovery, which *does*
run `loadWorkflowTree`, keeps reporting an on-disk id-less file as `valid: false`. This is not a
contradiction: discovery reports launch-validity, and this route reports bytes.

Responses:

- `200 OK` — `Content-Type: application/json`, the body is the file's raw bytes, the `ETag` header is
  set.
- `404 Not Found` — the file does not exist, `path` escapes the project root, or a path component is a
  symlink (same confinement as §7).
- `403 Forbidden` — a `GET` is ungated (§2.1), so this arises only if a future auth layer lands. It is
  listed for shape-parity, not emitted today.

## 8. Gaps this ticket surfaces (not blockers, flagged for the assembly ticket)

- `run-store`: add a "list root runs" query (§3).
- Discovery (§6) needs one additive helper: a directory scan plus per-file `loadWorkflowTree`
  classification. The loader primitives already exist (`tree.files` is the transitive nested-ref set,
  valid-root-detection.md §1). The scan plus set-subtraction lives in `@path/server`, no engine change.
- ~~No blob-serving endpoint in v0~~ — closed by issue #43: §4.1 serves `input`/`output` content over
  HTTP for clients that are not co-located with the server's filesystem.
- SSE replay depends on the `ndjson` log backend being enabled for the run (§5). A db-only read-back
  query was considered and dropped in favor of reuse of the existing NDJSON file.
