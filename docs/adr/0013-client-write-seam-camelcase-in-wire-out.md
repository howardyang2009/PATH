# Client write seam is camelCase-in, wire-out — not thin snake-through

**Status:** accepted; shapes the `@path/client-core` write surface added in
[#232](https://github.com/howardyang2009/PATH/issues/232) (part of
[#228](https://github.com/howardyang2009/PATH/issues/228)).

`PathApiClient`'s first body-bearing write, `startRun`, takes a **camelCase** options object
(`{ workflowPath, input?, config?, logBackends?, llmConcurrency? }`) and translates it to the snake_case
wire body at the boundary. Its return, and `listWorkflows`', stay **raw snake_case wire shapes**
(`StartRunResponse`, `ListWorkflowsResponse`). The seam is deliberately asymmetric: domain-shaped going
in, wire-shaped coming out.

Why: the designer and every future mobile surface import this seam (the #41 lesson: cheap to shape now,
expensive forever after). So the input casing outlives the ticket. `listRuns` already set this asymmetry
(camelCase `ListRunsQuery` in, snake_case `ListRunsResponse` out), and the package's stated intent is
that "surfaces name the domain through this one seam" (`client-core/index.ts`). `workflow_path` is simply
the first multi-word field where snake_case would otherwise leak into camelCase TS call sites. The
returns stay raw because `RunViewModel` consumes wire snake_case directly. A camelCase projection on the
read path would be the package's only one, and it would force a second shape with nothing to consume it.

## Considered options

- **Thin wire client (rejected).** `startRun(req: StartRunRequest)` takes the snake_case body verbatim,
  symmetric with the raw returns, no translation line. Rejected: it stamps `{ workflow_path,
  log_backends, llm_concurrency }` into every camelCase TS caller permanently, on a seam that is
  expensive to reshape once mobile and designer depend on it.
- **camelCase-in, wire-out (chosen).** One translation line at the boundary buys a domain-shaped input
  for every consuming surface. The read path stays wire-shaped for its one real consumer.

## Consequences

- The snake_case body still gets a **shared wire type**, `StartRunRequest` in `@path/schema`
  (`wire-v0.ts`), for the same reason `WireRunRecord` is shared: a body is client-encode and
  server-decode, and a field renamed on one side would type-check on both and break only at runtime. The
  camelCase-to-snake rename lives **inline** in `startRun` (like `listRuns` builds its query params
  inline), not as a shared encoder beside the shape. The `toWireRunRecord` pattern does not apply,
  because that encoder's input is a schema domain type, whereas `StartRunOptions` is client-local, and
  schema must not import client-core.
- The write helper splits rather than generalizes. A new `postJson<T>(path, body)` sends a body and
  parses the reply. `post()` stays body-less and reply-less for `cancelRun`. To read either helper tells
  you what kind of request it is without a trace of a flag, the same reasoning the existing
  `getJson`/`post` split records.
- `logBackends` is typed by a new `LogBackendId = "db" | "ndjson"` **owned by `@path/schema`**, not
  imported from `@path/engine`; client-core carries no engine dependency by design. This duplicates the
  engine's `LogBackendId`. To consolidate the two into one schema-owned source (engine re-exporting) is
  a deliberate follow-up, out of scope for a client-surface ticket.
