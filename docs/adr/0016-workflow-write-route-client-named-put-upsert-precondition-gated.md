# The workflow write route is a single client-named `PUT` upsert, gated by an ETag precondition

**Status:** accepted; resolves [#257](https://github.com/howardyang2009/PATH/issues/257) on map
[#254](https://github.com/howardyang2009/PATH/issues/254) (the Designer spec). Builds on
[ADR 0013](./0013-client-write-seam-camelcase-in-wire-out.md) (the camelCase-in / wire-out client
seam), [ADR 0015](./0015-designer-node-identity-client-mints-preserve-on-save.md) (client mints ids,
server never rewrites them), and [ADR 0006](./0006-workflow-and-node-identity-guid-plus-name.md). It
adds `@path/server`'s first write path for files; every prior route reads, or launches/cancels/resumes
a run.

## Decision

**One verb, `PUT /v0/workflows`, for both create and overwrite, with the resource path in the body,
not the URL.** The workflow's `relative_path` may contain `/` (`lib/draft.workflow.json`); carrying it
as an opaque `workflow_path` field in a `{ workflow_path, workflow }` envelope — exactly as
`POST /v0/runs` already does — dodges `%2F` path-segment encoding and lets the write reuse
`resolveWorkflowPath`'s escape/confine logic verbatim. The `workflow` field is the parsed workflow
object (snake_case wire, §1); the server serializes it deterministically
(`JSON.stringify(wf, null, 2) + "\n"`, author key order preserved) and owns the on-disk bytes.

**`PUT`, not `POST`-create / `PUT`-update.** `POST`-to-a-collection is the verb for *server-minted*
identity — you `POST /collection` and the server hands back a generated id and `Location`. Here the
**client** names the full resource path (and, per ADR 0015, mints node ids too — the server is a dumb
sink). When the client owns the URI, RFC 9110 §9.3.4 makes `PUT` the canonical create-or-replace verb.
A `POST`-create / `PUT`-update split would force the client to *know* whether the file exists to pick a
verb — a fact it cannot hold without a TOCTOU race against another editor or the [#258](https://github.com/howardyang2009/PATH/issues/258)
lease — and would spell the same write in two divergent routes. Existence-state moves off the verb and
onto an HTTP precondition instead, resolved atomically server-side.

**Concurrency is an ETag precondition, and blind last-writer-wins is unexpressible.** The single-file
read this ticket adds (`GET /v0/workflows/file?path=…`) returns a strong `ETag` = sha256 of the raw
file bytes. The write then reads intent from the conditional header:

- **no `If-Match`** → create-only: `412 Precondition Failed` if the file already exists;
- **`If-Match: <etag>`** → overwrite-only: `412` if the on-disk bytes changed or the file is gone.

There is no header spelling for "overwrite whatever is there" — every overwrite must present a matching
ETag. This is deliberate: #258's lease is politeness (best-effort, `sendBeacon` on tab close), and this
precondition is what actually protects the bytes. `412` (not the issue's originally-floated `409`) is
the idiomatic code for a failed `If-Match`/`If-None-Match`.

**The write validates the single file, not the tree.** It runs `@path/schema` (`WorkflowFileSchema`)
plus the whole-file duplicate-`id` check (one flat namespace — the workflow's own id, every node, every
parallel branch, every branch arm, the `else`; the same scope `name` uniqueness walks) and confines the
path. It does **not** run `loadWorkflowTree`: a saved file may reference a nested `workflow` not yet on
disk (a work-in-progress save, or a parent saved before its child). Ref resolution and cycle-checking
stay at launch, where `POST /v0/runs` already does them. A written file is therefore schema-valid but
not necessarily launch-ready — the same "schema-valid ≠ self-sufficient" asymmetry §6 discovery records.

## Consequences

- **A read/write casing asymmetry, by design.** `GET /v0/workflows/file` is *always raw*: it streams
  the file bytes verbatim and never runs the loader, so it serves an id-less-but-otherwise-fine file —
  the ADR 0015 handoff that lets the Designer stamp ids on import. The `PUT` is *strict*: `@path/schema`
  requires ids, so an id-less body is a `400`. The Designer mints ids client-side into its dirty buffer
  and always saves an id-bearing file. Discovery, which *does* run the loader, keeps reporting an
  on-disk id-less file as `valid: false` — not a contradiction: discovery reports launch-validity, the
  single-file `GET` reports bytes.
- **Symlinks are refused with a stronger check than discovery's.** Discovery only has to *not list* a
  symlink; a write must *not traverse* one, because a symlinked parent directory can redirect a write
  outside the project root even when the lexical path stays inside (lexical `resolve` won't catch it).
  The write refuses if any component of the resolved path is a symlink (per-component `lstat` /
  `O_NOFOLLOW`), as a `404` folded into the existing escape class.
- **The write route joins the §2.1 origin gate** (`403` cross-origin) — it is state-changing, so the
  same CSRF reasoning as `POST /v0/runs` and the cancel route applies.
- **Discovery is unchanged.** Its scan is stateless (`readdirSync` per call), so a newly written file
  appears on the next `GET /v0/workflows` with no discovery edit.
- **The client seam extends ADR 0013 to its first resource write.** `@path/client-core` takes a
  camelCase `{ workflowPath, workflow, ifMatch? }`, translates to the snake_case wire body + conditional
  header at the boundary, and returns the new ETag the server issued — the client never has to match its
  own serialization.

## Considered options

- **`POST /v0/workflows/:path` with the path in the URL (rejected).** Forces `%2F` encoding of every
  `/`-bearing relative path and a custom path-segment split, for no gain over an opaque body field the
  codebase already uses.
- **`POST`-create / `PUT`-update split (rejected).** Self-documents intent in the verb and gives an
  unambiguous `201`-on-create, but makes the client track existence (a race it can't win), spells one
  write as two routes, and makes create non-idempotent. Chosen alternative: one `PUT`, intent in the
  precondition header, `201`/`200` still distinguished by whether the file pre-existed.
- **mtime precondition (rejected).** Cheaper than hashing but coarse, clock-dependent, non-content (a
  bare touch false-conflicts). Chosen alternative: a content-derived sha256 ETag; the files are small
  enough that hashing is free.
- **Full `loadWorkflowTree` validation on write (rejected).** Would reject a legitimate WIP save whose
  nested ref isn't on disk yet. Chosen alternative: single-file schema + dup-id, tree resolution at
  launch.
