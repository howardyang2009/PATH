# Resume-from-K carries the source run id on the wire and persists a derivable descent path on the successor

Status: accepted

A Resume-from-chosen-K request ([#429](https://github.com/howardyang2009/PATH/issues/429), part of
map [#427](https://github.com/howardyang2009/PATH/issues/427)) names the rerun boundary **K** on the
wire by the **source node's run id** — one scalar field `rerun_from_run_id` on the existing
`POST /v0/runs/:root_run_id/resume` body (`packages/server/src/routes/resume-run.ts:10`), and
`path resume --from <run-id>` at the CLI. The engine (`Project.resume`,
`packages/engine/src/project.ts:199`) resolves that run id to the node-id **descent path**
`ResumeInput.rerunFromNodePath` (the mechanism mapped in
[#433](https://github.com/howardyang2009/PATH/issues/433),
`docs/research/resume-from-nested-k-mechanism.md`) by walking the source run's `parentRunId` to root,
validates the whole path against the current file before any successor starts, and persists it on the
successor's own root row as a new root-only column `rerun_from_node_path` (JSON `{nodeId, nodeName}[]`,
null on plain Resume), beside — not folded into — the existing `resumed_from_root_run_id`. The
persisted path is a read denormalization: correctness never reads it, since it is re-derivable from the
successor's own rows (at each level, the first child with a genuine-execution row, not a reuse row).

## Considered Options

### What names K on the wire

- **The source node's run id** (chosen). A run id is the one unambiguous handle: a bare node id is
  file-scoped and cannot tell two refs of the same nested file, or two loop iterations, apart
  (`CONTEXT.md` §Resume). The Designer's "Resume from here" already holds the run-tree node's run id,
  and the resume route is already keyed on run ids, so the client stays dumb and the run-id→path walk
  lives at one authority in the engine.
- **A pre-resolved node-id path (`string[]`) sent by the client.** Rejected: it pushes the
  tree-walk (`parentRunId` to root) and the file-scoping rule into every client, duplicating the one
  thing the engine is best placed to own.
- **A top-level index or bare node id.** Rejected as ambiguous, per the run-id argument above.

### Persist the descent path, or derive it on every read

- **Persist a new root-only column, correctness still derivable** (chosen). The Designer descent
  crumbs ([#418](https://github.com/howardyang2009/PATH/issues/418)) want K per crumb; a stored
  `{nodeId, nodeName}[]` is one clean source rather than a re-derivation each reader re-implements
  (classify each level: all-reuse = reuse, all-genuine = rerun-entire, mixed = descend). Cost: a
  schema bump.
- **Derive on read, persist nothing.** Rejected, narrowly. It avoids the schema bump and leaves
  "back-compat of existing run records" a non-issue, but every reader re-implements the level
  classification, and the field is exactly the kind of read-shaped denormalization the run rows
  already carry (`resumed_from_root_run_id`, `reused_from_run_id`). The bump cost is the project's
  normal accepted cost.

## Consequences

- **Two provenance facts stay separate.** `resumed_from_root_run_id` answers *which run the operator
  resumed* (tree-level, always the immediate predecessor, ADR 0001); `rerun_from_node_path` answers
  *where inside it K sat*. They are orthogonal columns, never one overloaded field — the same
  separation-of-questions principle as resumed-from vs reuse-marker (`docs/research/resume-run-identity.md`
  §3). The new field is exposed on the read wire (`packages/schema/src/wire-v0.ts` RunRow
  `rerun_from_node_path` → `packages/client-core/src/view-model.ts` `rerunFromNodePath`) so #418 reads
  it from the row.
- **Schema bump-and-break, no migration.** `SCHEMA_VERSION` goes 7 → 8
  (`packages/engine/src/persistence/db.ts`), adding `rerun_from_node_path TEXT` to the `runs` table.
  An existing pre-#429 db refuses to open with the standard message rather than silently lacking the
  column a successor would write to — the seventh such bump, identical policy to #19/#169/#204/#202/#257/#332.
  No backfill: the store is a clean slate. This is the whole of the "back-compat of persisted run
  records" the ticket asked about — there is no mixed-version world to reconcile.
- **One authority resolves and validates; the route only translates.** `Project.resume` holds both
  halves the check needs — the original tree rows (`getRunsForRoot`, `project.ts:210`) and the current
  `rootFile` — so it resolves the run id, matches the node-id path against the current file, and
  enforces legal-K. It returns a structured `refusal: {status, message}` (the pattern `prepareWorkflow`
  already uses, `resume-run.ts:92`), folding today's root-not-found into it as `{status: 404, …}`, so
  the route has one exit for every engine-side refusal and no hardcoded status. The engine's per-level
  `i < 0` throw (nested-K doc §7) is a backstop only, never reached after validation.
- **The refusal taxonomy**, checked only when `rerun_from_run_id` is present, in dependency order
  (first failure wins): (1) run id in no run of the source tree — **400**; (2) resolves to a
  since-deleted node — **409**; (3) illegal locus, inside a loop/parallel/branch body — **400**
  (#427 out of scope); (4) K node not succeeded — **409**; (5) prefix `<K` not fully succeeded —
  **409**. 400 = unresolvable or unsupported selection (pairs with the existing invalid-body 400);
  409 = state or file-divergence conflict (pairs #2 with the existing workflow-id-changed 409).
- **Plain Resume is unchanged, one code path.** An absent `rerun_from_run_id` sends no path, seeds
  `rerunFromNodePath = []`, writes `rerun_from_node_path = null`, and behaves byte-for-byte as today's
  resume — plain Resume is the K = auto-boundary case of the one action, not a second route.
