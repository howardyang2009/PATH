# The Template API is id-addressed and owns the template write door

**Status:** accepted; resolves the API decision of Wayfinder map
[#558](https://github.com/howardyang2009/PATH/issues/558), ticket
[#563](https://github.com/howardyang2009/PATH/issues/563) ("Server template API spec"). It builds on
[ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md) (the
`.step-template.json` envelope over a validated body), [ADR 0049](0049-instantiation-is-a-detached-copy-that-re-stamps-ids-and-never-rewires.md)
(detached-copy instantiation and the two save modes), [ADR 0015](0015-designer-node-identity-client-mints-preserve-on-save.md)
(the client mints ids, the server never rewrites them), [ADR 0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md)
(the workflow write door: one verb, path in body, `If-Match` precondition), and [ADR 0006](0006-workflow-and-node-identity-guid-plus-name.md)
(the `id`=GUID / `name`=human split). The endpoint surface is `docs/api/server-api-v0.md` §10; the
glossary terms are `CONTEXT.md` § Templates.

A **Template** is Server-owned and engine-blind ([ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md)),
so the Designer reaches it only over HTTP. The palette needs to list the union of shipped and user
templates, read one to instantiate it, and — for **author mode** ([ADR 0049](0049-instantiation-is-a-detached-copy-that-re-stamps-ids-and-never-rewires.md)
decision 8) — create, edit, and delete the user-writable ones. This ADR fixes how those routes address
a template, how the union is discovered, and which write door owns a `*.workflow-template.json`.

## Decision

**The template routes address a template by its GUID, discover the shipped∪user union on each request,
and are the one write door for every template artifact of either kind.**

1. **Id-addressed, not path-addressed.** `GET`/`PUT`/`DELETE /v0/templates/:id` take the template's own
   GUID in the URL — a step-template's envelope `id` ([ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md)),
   a workflow-template's own workflow `id`. This is the deliberate divergence from the workflow routes,
   which carry a relative *path* ([ADR 0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md)
   §7, §7.1). A workflow is launched by where it lives; a template is *selected by identity* and its
   on-disk location is an implementation detail split across two roots. A GUID is unique by construction
   ([ADR 0006](0006-workflow-and-node-identity-guid-plus-name.md)), so one id lookup spans both kinds
   with no `?kind=` disambiguator. The server resolves `:id` through an index `id → {kind, origin,
   absPath}` built from the same union scan that backs the list; no id is ever minted, re-stamped, or
   rewritten by the server ([ADR 0015](0015-designer-node-identity-client-mints-preserve-on-save.md)).

2. **The union is a four-directory scan, origin-flagged.** Discovery scans
   `packages/server/template/{step-template,workflow-template}/` (**shipped**, `read_only: true`,
   portable within the fork lineage) and `.path/template/{step-template,workflow-template}/` (**user**,
   `read_only: false`, project-scoped). Files are typed by suffix — `*.step-template.json`,
   `*.workflow-template.json` — never by inspecting their bytes, so the kind of a file is a fact about
   its name, as a step-plugin folder's type is its folder name. Each entry carries `origin` and the
   derived `read_only`. There is no cache: a fresh scan per request, the same stance as `GET
   /v0/workflows` (§6).

3. **An id collision across origins lists both; the later one is invalid.** Two templates that share a
   GUID is reachable only when a user hand-copies a shipped file into `.path/template/` — save-as always
   mints a fresh envelope id ([ADR 0049](0049-instantiation-is-a-detached-copy-that-re-stamps-ids-and-never-rewires.md)).
   When it happens, both list, and the **user** entry is flagged `valid: false` with a duplicate-id
   error, exactly as `PUT /v0/workflows` reports an internal duplicate id ([ADR 0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md)).
   This is **not** plugin masking ([ADR 0020](0020-plugin-masking-is-inherited-and-a-plugin-is-engine-trust.md)):
   masking resolves an engine-trust code precedence, while a template is a read-only *data* artifact with
   no precedence to resolve. A **name** collision across origins is not a collision at all — two rows with
   distinct ids and distinct palette labels. The server never fails to start over a bad data file
   ([ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md) decision
   8): a duplicate id, an unregistered step type, or malformed JSON invalidates *that one entry* and
   every other template still lists.

4. **The list is thin; the body rides `GET /:id`.** `GET /v0/templates` returns one summary per entry —
   `{ id, name, description, kind, origin, read_only, valid, error }` — and **no `body`**, mirroring the
   workflow-discovery summaries (§6). The palette renders the list; instantiation fetches the one
   template it needs. `kind` is an **optional** filter (`?kind=step|workflow`); omitted, the response is
   the union of both kinds, each row carrying its own `kind`. Validity is registry-relative and per
   entry: a template naming a step type this tree lacks lists with `valid: false` and its error, so the
   palette never offers an insertable template that would fail on insert
   ([ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md)).

5. **`GET /:id` returns a parsed envelope with a byte-exact ETag.** The response is `{ id, name, kind,
   origin, read_only, format, description, body, valid, error, etag }`, where `name` is derived
   server-side from the file stem ([ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md))
   and `etag` is the sha256 of the exact on-disk bytes. This is the one place the template read is *not*
   the raw-bytes read the workflow route uses (§7.1). §7.1 serves raw precisely to hand the Designer an
   **id-less** file it will stamp on import; a template is **never id-less** (its identity is the GUID it
   was born with), so there is nothing to preserve by serving raw, and the envelope must carry `name`,
   `origin`, and `read_only`, none of which live in the bytes. The byte-exact `etag` still feeds the
   `If-Match` precondition on `PUT` unchanged. An **invalid** template still returns `200` with `valid:
   false` and its `error`, body included — an author must be able to open a broken template to repair it,
   the same leniency discovery shows (§6).

6. **`POST /v0/templates` is create-only and writes to `.path/template/` alone.** The body is `{ kind,
   name, description, body }` with the envelope `id` **already minted by the client** and carried in
   `body` — the server is identity-agnostic ([ADR 0015](0015-designer-node-identity-client-mints-preserve-on-save.md)),
   as it is for `PUT /v0/workflows`. The server confines the write to
   `.path/template/<kind-dir>/<name>.<suffix>` (creating the directory chain), asserts `name` matches
   `NameSchema` (`^[a-z][a-z0-9-]*$`) — a `400` otherwise — validates the body against
   `makeStepTemplateSchema(registry)` / the workflow-file schema, and refuses a name that already exists
   with a `409`. There is no blind overwrite; content changes go through `PUT`. A shipped path is never a
   POST target: the route writes only under `.path/template/`.

7. **`PUT /v0/templates/:id` is update-only and precondition-gated.** It requires `If-Match` carrying the
   `etag` from a prior `GET /:id`; a stale or absent token is a `412`, the [ADR 0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md)
   contract. Unlike `PUT /v0/workflows`, it is **not** an upsert: a `PUT` to an id that resolves to no
   file is a `404`, because creation is POST save-as. The route **cannot rename** — the file stem, hence
   the template's `name`, is immutable through this door (a rename is a file rename,
   [ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md)); a body
   whose `id` disagrees with the URL id is a `400`. A write to a **shipped** template is a `403` "template
   is read-only". The server serializes the *raw* request object (author key order preserved), as
   `put-workflow` does.

8. **The template routes own the write door for both kinds; the workflow routes never touch a template.**
   [ADR 0049](0049-instantiation-is-a-detached-copy-that-re-stamps-ids-and-never-rewires.md) decision 8
   frames author-mode editing of a `*.workflow-template.json` as "ordinary file editing under the
   [ADR 0015](0015-designer-node-identity-client-mints-preserve-on-save.md) round-trip." That names the
   **mechanism** — a dirty buffer, a byte-exact `If-Match` precondition, ids preserved on save — not the
   **route**. That mechanism runs over `GET`/`PUT /v0/templates/:id` here, id-addressed, so a
   workflow-template is read and written through exactly one surface regardless of which of the two save
   modes the Designer is in. To keep the two write doors disjoint, `PUT /v0/workflows` **rejects** a path
   under `.path/template/` or bearing a `*.workflow-template.json` suffix: a workflow-template is writable
   only through the template route. `GET /v0/workflows` already ignores them — it scans `*.workflow.json`
   only (§6) — so a template never surfaces as a launchable workflow.

9. **`DELETE /v0/templates/:id` removes a user template.** Success is `204` with no body; a **shipped**
   target is a `403`; an unknown id is a `404`. Deleting a missing template is `404`, not an idempotent
   `204` — the route reports resource-not-found rather than silently succeeding, matching the id-lookup
   stance of `GET`/`PUT`. The delete is origin-gated (§2.1) like every state-changing route.

10. **The gate split follows every other route.** `POST`, `PUT`, and `DELETE` are state-changing and pass
    the §2.1 origin gate; `GET /v0/templates` and `GET /v0/templates/:id` are pure reads and are ungated,
    the same asymmetry as §6/§7 and §8.

## Considered options

- **Address a template by relative path, like a workflow (rejected).** It reads the map's "id scheme"
  requirement out of the ticket and it fits templates badly: a template lives under one of two roots and
  is chosen by identity, not by launch location. A path would also make the shipped∪user union a
  path-namespace merge with a shadowing rule, where a GUID union has none. The workflow route is
  path-addressed because a run is launched by *where* the file is; a template has no such tie.

- **Require `?kind=` on `GET /:id`, giving each kind its own id namespace (rejected).** GUIDs are globally
  unique ([ADR 0006](0006-workflow-and-node-identity-guid-plus-name.md)), so a kind discriminator on a
  by-id lookup is redundant, and it would force every caller holding only an id to also know its kind. The
  discovery index carries the kind; the URL need not.

- **A fat list that inlines every `body` (rejected).** It saves the instantiate round-trip at the cost of
  shipping every workflow-template's full tree in the palette payload, and it diverges from the
  workflow-discovery summary shape (§6) for no rule that needs it. The palette lists metadata and fetches
  the one body it instantiates.

- **Serve `GET /:id` as raw bytes, like `GET /v0/workflows/file` (rejected).** §7.1 serves raw only to
  preserve an **id-less** handoff the Designer stamps on import; a template is never id-less, so raw
  preserves nothing here, and `name`/`origin`/`read_only` are not in the bytes anyway. A parsed envelope
  with a byte-exact `etag` gives the precondition token without the raw contract.

- **Make `PUT /v0/templates/:id` an upsert, like `PUT /v0/workflows` (rejected).** The workflow route is
  create-or-overwrite because a client names its own path and there is no prior "create" verb; the
  template surface *has* a create verb (POST save-as), so a PUT to an unknown id is a client error worth a
  `404`, not a silent create at a path the URL does not even carry.

- **Route author-mode workflow-template edits through the workflow routes (rejected — the Q4 (a)
  option).** A `.path/template/workflow-template/x.workflow-template.json` is under the project root, so
  `PUT /v0/workflows` *could* write it. But then a workflow-template would be read by id (consume) and
  written by path (author), split across two surfaces with two addressing schemes, and the shipped∪user
  read-only story would have to be re-implemented on the workflow route. One id-addressed surface for both
  save modes is the simpler invariant; [ADR 0049](0049-instantiation-is-a-detached-copy-that-re-stamps-ids-and-never-rewires.md)'s
  "ordinary file editing" is honoured as a mechanism, not a routing claim.

- **Shadow a shipped template with a same-id user template (rejected).** Masking is the engine-trust
  precedence of [ADR 0020](0020-plugin-masking-is-inherited-and-a-plugin-is-engine-trust.md); a template
  is read-only data with nothing to execute and no precedence to resolve. A duplicate id is a data error
  flagged on the user entry, not a silent override.

## Consequences

- **The server grows one discovery helper and five route handlers, no engine change.** Discovery is a
  four-directory scan plus a suffix classification and a per-file schema check, all in `@path/server`; the
  engine never reads a template ([ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md)).
  The id→file index is a by-product of the same scan.

- **The Designer has one template surface for both kinds and both save modes.** List, read-to-instantiate,
  save-as-new, edit-in-place, and delete all speak `/v0/templates`, id-addressed. Author-mode save
  ([ADR 0049](0049-instantiation-is-a-detached-copy-that-re-stamps-ids-and-never-rewires.md) decision 8)
  is `PUT /v0/templates/:id`, not a workflow write.

- **The two write doors are disjoint by construction.** `PUT /v0/workflows` refuses a `.path/template/`
  or `*.workflow-template.json` path, and `GET /v0/workflows` never lists one, so a template can be
  launched only after it is instantiated into a `*.workflow.json`, never in place.

- **Validity is honest and per entry.** A broken template lists with its error and reads back with `200`
  + `valid: false`, so the palette can grey it out and an author can still open it to fix it, while every
  other template lists and instantiates.

- **This ticket writes no production code.** The output is this ADR, `docs/api/server-api-v0.md` §10, and
  the `CONTEXT.md` § Templates route terms. The build session implements the discovery helper, the five
  handlers, and the `PUT /v0/workflows` template-path guard.

- **Acceptance.** `GET /v0/templates` lists a shipped step-template and a user workflow-template with the
  right `origin`/`read_only`; `?kind=step` filters to step-templates only. `GET /v0/templates/:id` on a
  valid template returns its envelope and a byte-exact `etag`; on an unregistered-type template returns
  `200` + `valid: false` + body; on an unknown id returns `404`. `POST /v0/templates` writes
  `.path/template/step-template/<name>.step-template.json`, returns `201`, and a second POST of the same
  name returns `409`; a `name` violating `NameSchema` returns `400`. `PUT /v0/templates/:id` with the
  matching `If-Match` updates in place and returns `200`; a stale `If-Match` returns `412`; a `PUT` to a
  shipped id returns `403`; a `PUT` to an unknown id returns `404`. `DELETE /v0/templates/:id` on a user
  template returns `204`; on a shipped id `403`; on an unknown id `404`. `PUT /v0/workflows` to a
  `*.workflow-template.json` path is refused.
