# Changelog

## v0.5.1 — 2026-08-20

One shape, everywhere. The **workflow format grows up again** — `path/workflow@1`'s three different
container slots collapse into a single uniform node shape, and a new `sequence` logicer carries the
"run these in order" case that used to be smuggled inside a bare node array. A parallel branch is now
just a node (it already carries its own `id` + `name` — the `collect`/`wait-one` key — so the old
`{id,name,body}` wrapper was pure ceremony); a branch arm, an `else`, and a `while-do` body each hold
one `node` instead of a body; and where several steps really do run in sequence you name a `sequence`
node and put them in its `body`. The count of multi-node slots in the format drops to the two that
earn it (top-level `body`, `sequence.body`), per ADR 0014.

The break is clean-slate and codemod-migrated, exactly like the `@0` → `@1` before it. `FORMAT_VERSION`
becomes `path/workflow@2`, the only accepted string; an `@0` or `@1` file is rejected at load with a
targeted message that now names the **whole codemod chain** to run (`@0` is told to run the v1 script
_then_ the v2 script, not pointed at a v2 codemod that would silently skip it). `scripts/migrate-workflow-format-v2.ts`
is the one-time, fill-once write-back: it unwraps single-node branches (renaming the node to the
wrapper's `name` so the output key is byte-preserved), wraps genuinely multi-node branches in a minted
`sequence`, converts every single-`node` slot from an array to one node, preserves every existing
`id`, is idempotent, and refuses on a post-migration name collision rather than inventing a name. This
repo's own fixtures and the last two dogfood workflows are already on `@2`.

No DB break this time — the store schema is untouched, so an existing `path.db` keeps opening.

Two refactors ride along (#290, both Opus 5). `loadWorkflowTree` now hands callers a `LoadedWorkflow`
that owns the three facts every caller used to re-derive (`rootFile`, `workflowDir`,
`storeRelativePath`), deleting three unreachable "internal error"/500 branches and three non-null
assertions. And the two launch routes — `POST /v0/runs` and its resume sibling — collapse behind one
`launch.ts` `prepareWorkflow`, so the ADR 0012 `$env` reject and the escape/not-found/invalid gate are
each spelled once instead of drifting in two copies.

Suite 1119 across the six packages (schema 235, client-core 51, engine 564, viewer 121, server 134,
scripts 14), typecheck green throughout; `scripts/` now runs inside CI (#287).

### Breaking Changes

- **Format `path/workflow@1` → `path/workflow@2`** (#278) — the three `@1` container slot shapes
  become one node shape. `parallel.branches` is an array of nodes (the `{id,name,body}` wrapper is
  gone); a branch arm is `{when, node}`, an `else` is a single node, and `while-do` uses `node`
  (renamed from `body`). No backward compatibility: an `@1` (or `@0`) file is rejected at load with a
  run-the-codemod message. Migrate with `scripts/migrate-workflow-format-v2.ts` (fill-once, idempotent,
  refuses on a name collision).
- **`sequence` node** (#278) — the multi-step case that lived in a bare node array is now an explicit
  `{type: "sequence", id, name, body}` logicer (body: node array, min 1); output is the last child's.
  As a logicer it rejects worker/config/input/parse/publish. Only two multi-node slots remain in the
  format: top-level `body` and `sequence.body`.

### Features

- feat(schema): `@2` uniform single-node containers + `sequence` logicer (#278) — collapses the three
  `@1` slot shapes into one node shape and adds `sequence`, per the frozen `workflow-format-v2.md`
  spec. `FORMAT_VERSION` is `path/workflow@2`, the only accepted string; `node-walk` re-expresses each
  single-node slot as a one-element body and drops the `branchName` special case.
- feat(engine,server): consume `@2` single-node containers + `sequence` (#278) — branch arm / `else` /
  `while-do` body run as one-node sequences; the `sequence` logicer runs its body nested, output = last
  child. `run-parallel` and `plan-reuse` walk `[branch]` for a branch-as-node.
- feat(scripts): `@1` → `@2` workflow-format codemod (#278) — the one-time repo codemod the loader's
  rejection names, following its `@0` → `@1` predecessor. Unwraps single-node branches (name-preserving),
  wraps multi-node ones in a minted `sequence`, converts single-`node` slots, preserves ids, idempotent,
  refuses on a name collision.

### Fixes

- fix(schema): name both codemods when rejecting a `@0` file (#280) — `SUPERSEDED_FORMAT_VERSIONS` maps
  each superseded version to the codemod chain that lifts it to `@2`, joined with " then ". An `@0` file
  now reads "run `migrate-workflow-format-v1.ts` then `migrate-workflow-format-v2.ts`" instead of being
  pointed at a v2 codemod that would silently skip it. `@1`'s sentence is byte-identical.

### Internal

- refactor(engine): deepen the workflow loader — `loadWorkflowTree` returns a `LoadedWorkflow` owning
  `rootFile` / `workflowDir` / `storeRelativePath`; four production sites and four tests stop
  re-deriving them, and three unreachable error branches plus three non-null assertions are deleted
  (#290).
- refactor(server): one `launch.ts` `prepareWorkflow` behind both `POST /v0/runs` and the resume route —
  the ADR 0012 `$env` reject and the escape/not-found/invalid gate spelled once; `operator-config.ts`
  folded in and deleted (#290).
- chore(dogfood): migrate the last two `@1` workflow files to `@2` (#281).
- test(engine,schema): cover `@2` sequence + branch-as-node dispatch (#279); pin the `@1`/`@0` load
  rejection across every load surface (#282, #280); guard the inline-fixture stampers against the `@1`
  slot shape (#282).
- test(scripts): cover the `@1` → `@2` codemod and put `scripts/` inside CI (#287).
- docs: `workflow-format-v2.md` + ADR 0014 record the two structural rulings (single-node containers,
  `sequence` over an optional body) with their rejected alternatives; `mvp-spec`, `CONTEXT`, and the
  glossary graduate to `@2` (#269–#275).

## v0.5.0 — 2026-08-16

Two things grow up in this release. The **engine learns to fan out and rejoin** — `wait-one` races
its branches and keeps the first winner, `do-not-wait` launches a branch and lets the enclosing run
continue behind a join barrier. And the **viewer stops being read-only**: it discovers the store's
workflows, launches runs, and resumes a cancelled or failed run, all from the console. Underneath
both, workflow and node identity is rebuilt on a durable GUID so a rename never breaks reuse or
resume.

Two coupled breaks land together (ADR 0006 → ADR 0007): the **workflow format** and the **audit
tables**. The workflow and every node/branch now carry a two-part identity — a durable UUIDv4 `id`
(the stable machine identity: the reuse/resume key and the `node_id` a run row and log event carry)
plus a human `name` (the readable identity: it keys `collect`/`wait-one` output, is what the log
stream narrates, names the node in error messages, and stays unique across the whole file). The old
human node `id` **becomes** `name`; the `id` field is repurposed for the GUID, so `id` is required
everywhere. Format bumps to `path/workflow@1`; a file still on `@0` is rejected at load with a
targeted message naming the codemod, not a generic schema error. Renaming a node's `name` no longer
breaks resume, because the match is on the stable GUID — the payoff of ADR 0006, now concrete.

Both breaks are clean-slate: the store resets on the DB bump (v3 → v4, new `node_name` columns on
`runs` and `log_events`), so no old row ever carries a stale human `node_id`. There is no runtime
auto-stamp — the single sanctioned write-back is a one-time committed codemod
(`scripts/migrate-workflow-format-v1.ts`) that rewrote this repo's own fixtures and
`docs/**/*.workflow.json`.

On top of that, #202 lands the half ADR 0006 deferred: each **root run** now records the producing
workflow's **source-workflow identity** — its durable GUID `workflow_id`, human `workflow_name`, and
store-relative `workflow_path` (root-only, null on every nested row). `path runs list` grows a
`workflow` column and `--workflow <name>` / `--workflow-id <guid>` filters, so a central `-C` store
(ADR 0005) segments runs by the workflow that produced them instead of listing an anonymous pile of
run-ids. ADR 0006 costed the columns as part of the same v3 → v4 bump; the work split across two
tickets, so they land as a second clean-slate DB break (v4 → v5) — same reading, no backfill.

Suite 1055 across the five packages (schema 219, client-core 51, engine 540, viewer 121, server
124), typecheck green throughout.

### Breaking Changes

- **Format `path/workflow@0` → `path/workflow@1`** (#204) — required GUID `id` on the workflow and
  every node/branch, and the node/branch human `id` renamed to `name`. No backward compatibility: a
  missing `id` is a load error, an `@0` file is rejected with a run-the-codemod message. Existing
  files are migrated by `scripts/migrate-workflow-format-v1.ts` (fill-once, never regenerated).
- **DB schema 3 → 4** (#204) — `node_id` now stores the GUID and a `node_name` column is added to
  both `runs` and `log_events`. Bump-and-break with no migration (pre-1.0); an existing `path.db`
  refuses to open. Blobs under `.path/runs/` are unaffected.
- **DB schema 4 → 5** (#202) — three source-workflow columns (`workflow_id`, `workflow_name`,
  `workflow_path`) added to `runs`, recorded root-only. Same bump-and-break, clean-slate reading; an
  existing `path.db` refuses to open, blobs unaffected.
- **`wait-one` output contract** (#204) — the block output field renames `id` → `name`:
  `{ winner: { name, output } }`. A step reading `output.winner.id` via interpolation now reads
  `.name`. `collect` output stays `{ branch-name: output }` — keyed by `name`, unchanged in shape.

### Features

- feat(schema): durable GUID `id` + human `name` on the workflow and every node/branch (#204) — `id`
  is a UUIDv4 (machine identity, reuse key), `name` the readable label (output keys, log narration,
  error text, whole-file uniqueness); symmetric across workflow and node, per ADR 0006.
- feat(engine): audit keys on the GUID, narrates the name (#204) — `nodeName` threaded through
  `RunIdentity`, every `Observation`, the log-event envelope, run rows, and the db/ndjson backends;
  `node_id`/`node_name` are both null exactly at the implicit root step. Error messages switch from
  `id` to `name` (`binary-worker`, `agent-sdk-worker`, `run-workflow`).
- feat(engine): source-workflow identity on the root run (#202) — the root `run-started` carries the
  producing workflow's `workflowId`/`workflowName` (from the file) plus a launcher-supplied
  `workflowPath`, persisted root-only to the new `runs` columns and surfaced on `RunRecord` and the
  v0 wire record. `path runs list` gains a `workflow` column and `--workflow`/`--workflow-id` filters;
  the CLI records the workflow path relative to the (possibly `-C`-relocated) store dir.
- feat(engine): `wait-one` parallel join (#198, #199) — a block that races its branches and keeps the
  first winner, output `{ winner: { name, output } }`; all-branches-fail aggregates with no winner
  (#196), per ADR 0004.
- feat(engine): `do-not-wait` launch-and-continue join (#109, #210–#212) — a branch fires and the
  enclosing run proceeds, with an enclosing-run barrier that still joins before the root completes.
  Failure stays isolated to the branch and raises no new cancel cause; in-branch publish is accepted
  or rejected at the schema (ADR 0008/0009).
- feat(cli): `path run -C <dir>` relocates the `.path` store (#201) — reads and writes go to the
  named store dir instead of the workflow's own directory.
- feat(client-core): `startRun(body)` + `listWorkflows()` write surface (#232) — the client can now
  launch runs and enumerate workflows, not only read run state.
- feat(server): `GET /v0/workflows` discovery endpoint (#243, #246) — lists all workflows in the
  store with root workflows flagged.
- feat(server): CSRF / origin gate on state-changing routes (#237, #247) — every mutating v0 route
  now checks origin, so a browser page cannot drive the local server cross-site.
- feat(server): operator override config rejects `$env`, accepts literal `$secret` (#231, #248,
  ADR 0012) — secrets resolve through the sanctioned path, environment interpolation is refused.
- feat(viewer): inline launch panel — discover + launch workflows (#233) — pick a workflow and start
  a run from the console, backed by the new `client-core` write surface.
- feat(viewer): resume a cancelled or failed run from the console (#249) — a Resume control in the
  runs rail, under the selected row.
- feat(viewer): drag-resizable panes, tree/narrative split, richer tree rows (#251) — resize the
  three console panes and the run-tree/narrative split by dragging (widths persist); run-tree rows
  lead with the human node name, trailed by the GUID and run-id.

### Internal

- refactor(schema): consolidate `LogBackendId` into `@path/schema` (#240, #250).
- refactor(engine): run-scoped `Emitter` that owns the observation envelope (#225); deepened resume /
  parallel-block / CLI-value-flag decisions (#224); pinned observer order and retired
  `composeObservers`' stale contract (#227).

## v0.4.4 — 2026-08-08

Minor: `path run --resume <root-run-id>` ships end to end, closing the third of #109's deferred
doors. A stopped tree — failed, cancelled, or forced-killed — re-runs as a **successor run**: every
node that reached `succeeded` is reused verbatim, everything else runs again, and the original tree
is opened for reading only, never written. The side-effect contract is at-least-once, stated plainly
now in `README.md` and `mvp-spec.md` §3 — a step whose real-world effect landed just before a kill
runs again on resume, because the engine has no way to know the effect already happened.

The door took three wayfinder maps to open (#142 → #158 → #168) before a line of resume code
existed: #142 settled *what resume means* against a frozen bar, using a real kill-and-measure
exercise (forced `^C` mid-`while-do`, $0.91 gross re-burn, $0 residual after manual salvage) rather
than argument; #158 charted the CLI/format/engine surface across five grilling tickets, each
decided and posted as a closed issue comment rather than a redundant ADR where the record didn't
need one; #168 filed the implementation as one spec, synthesized from a deep read of the shipped
codebase rather than another interview. Two ADRs came out of the middle map and hold for the
surface that shipped: **ADR 0002** — `rm --force` overrides a live reuse-marker block but never
cascades, deleting exactly the named tree and naming every successor it orphans; **ADR 0003** — a
resumed run's context is restored by load from the original tree, so `--context`/`--set-context`
combined with `--resume` is a hard validation error, not silent-ignore.

What actually reuses: a node id matched against the original tree's `RunRecord[]`, scoped to one
file's own children so a succeeded workflow-run's whole subtree collapses without being individually
inspected (`planReuse`, #170). A reused node emits one `reuse-marker` — a new `Observation`/`LogEvent`
member that persistence drops (no run row) but logging keeps, so the narrative stays complete without
a phantom row claiming work that didn't happen (#172). Cost crosses the reuse boundary the same way:
`RunArchive.cost` sums a tree's own rows, then for every reuse-marker it holds, reaches into the
**original** tree via the marker's `original_run_id` — a resume with nothing reused matches a
from-scratch run's total exactly (#176). `path runs`, previously only a landing pad for `rm`/`prune`,
gets its first bare listing: root runs most-recent-first, a `resumed-from` cell that is `-` (no
predecessor), the predecessor's id verbatim (still live), or `<id> (deleted)` (no longer has rows) —
liveness is existence in the `runs` table, not presence on the current `--limit` page (#174). `rm`
without `--force` now blocks when some other live successor tree holds a reuse-marker into the one
being deleted (#175).

The dogfood exercise that closed a different, declined door rode along in this range: a 12-node
GitHub-enrichment pipeline, written in format v0 exactly as it stands, ran live against
`v0.4.1..v0.4.3` and correctly resolved 24 of 24 commit-subject references against the GitHub API on
the first authenticated attempt (#133/#139). It supplied the human observation the API-endpoint
door's rubric was missing; weighed against the frozen bar, the door **stays shut** — the decisive
route (token in argv) came back `fine` because `curl --config -` keeps the credential off the process
table (#135/#141). `extends`/templates is reclassified from a self-contradicting spec (ruled-out in
§1, deferred in §10) to a settled **door**: still not in v0, arriving as an addition rather than a
redrawn destination when it comes (#128).

Suite 827 → 899 across the release (schema 201, client-core 42, engine 416 → 488, viewer 89, server
79), every existing test passing untouched at each step.

### Features

- feat(schema): `resumed_from_root_run_id` column, schema version 3 (#169) — nullable, root rows
  only; carries the tree-level "resumed from" relationship, kept deliberately separate from the
  node-level reuse-marker (ADR 0001 precedent), since a multi-hop resume chain can have the two
  naming different trees for the same resume.
- feat(engine): reuse-plan pure function (#170) — `planReuse` matches an original tree's run rows
  against a re-read `WorkflowFile` by node id; a node id with more than one succeeded candidate (a
  revisited `while-do` body) does not reuse, since which attempt answers a single re-read node is
  undefined.
- feat(cli): `path run --context <file>` / `--set-context key=value` (#171) — seeds or overrides a
  fresh run's starting context, sharing one merge algorithm with `--config`/`--set` (ADR 0003).
  Combined with `--resume`, both flags are a hard CLI validation error.
- feat(engine): consume reuse plan on resume (#172) — reused nodes short-circuit with a
  `reuse-marker` and the original run's `output.json`; every non-succeeded workflow-run in the tree,
  root or nested, restores its context by loading the original's `context.json` verbatim.
- feat(engine): `Project.resume(rootFile, rootRunId, workflowDir, opts)` (#173) — the one call site
  `run` and a future server route both converge on; returns a discriminated `ResumeResult` rather
  than throwing on an unknown root run id, and stamps `resumed_from_root_run_id` on the successor's
  root row at insert, never a post-hoc `UPDATE`.
- feat(cli): `path runs` bare listing subcommand (#174) — root runs most-recent-first, full
  untruncated ids, the three-form `resumed-from` cell described above.
- feat(cli): `path runs rm --force` reuse-marker guard (#175) — blocks a delete by default when a
  live successor tree still references the target via reuse-marker; `--force` overrides with no
  cascade and names every tree it orphans.
- feat(engine): `RunArchive.cost` sums crossing tree boundaries (#176) — a root run's whole-tree
  spend, reaching into an original tree through every reuse-marker the successor holds; a deleted
  original tree contributes 0 rather than erroring.
- feat(cli): `path run --resume <root-run-id>` (#177) — the workflow file argument stays mandatory
  (no persisted workflow path exists in the schema); the successor's fresh root run id prints on
  every outcome — succeeded, failed, cancelled alike — so an operator can chain a further `--resume`
  regardless of how it ended.
- feat(cli): `path runs`/`rm`/`prune` accept `-C <dir>` (#190), matching `git -C`, to target another
  project's `.path/` without `cd`ing there.
- feat(cli): `path runs` gains `started`/`finished` columns (#191) — `RunRecord.startedAt`/
  `finishedAt`, ISO 8601, `-` when null; the id column header becomes `root-run-id`.
- feat(dogfood): the GitHub-enrichment workflow, built in format v0 and run live (#133/#139) — no
  engine, schema, or format change; supplied the missing human-observation route for the
  API-endpoint door's rubric.

### Fixes

- test(engine): resume acceptance exercise (#178) — the release-notes acceptance pipeline now drives
  a genuine mid-`while-do` cancellation via `AbortController`, then `path run --resume` through the
  real CLI, asserting reused nodes are not re-billed (re-burn `== 3 × SCRIPTED_COST_USD`, the three
  LLM steps that truly re-ran).

### Internal

- docs(spec): `extends` reclassified from a self-contradicting out-of-scope/deferred-door split to a
  settled door (#128) — §1 states the positive rule directly instead of pointing back at a bullet
  that disagreed with §10.
- docs(research): the API-endpoint door stays shut, on the evidence (#135/#141) — `Q2`/`Q3` collapse
  under the rubric's own weighing rule, leaving 2 of 3 contributory-route hits, not 3.
- docs(readme): status line refreshed for the shipped resume work (#189) — release list, unreleased
  section, and the `#109` door queue all brought current with `main`.

## v0.4.3 — 2026-08-02

Minor: the first of #109's three deferred doors is shipped, and the second architecture-review pass
that had been sitting merged-but-unreleased on `main` ships with it. `$env` is the feature — a config
value can name an environment variable instead of carrying a literal, and can compose with `$secret`
so the sourced value is both usable and masked. What it earns is narrower than "run non-interactive",
which already worked: a secret becomes **addressable** (`${config.token}` into argv, prompt, input)
and **maskable** (it joins the collected-secret set) without ever sitting in a workflow file, a
`--config` file on disk, or `--set` in shell history.

The format stays `path/workflow@0`. Two things about it change for an author. `$secret`'s value
widens from `string` to `string | {"$env": "NAME"}` — one-way nesting, `$env` inside `$secret` and
never the reverse. And the `$`-sole-key namespace is now **reserved**: any sole-key object whose key
starts with `$` and is not a known wrapper is a load error, where before `{"$evn": "TOKEN"}` passed
silently as literal data and the worker got the wrapper instead of the token. That is the one change
here that can reject a file which loaded in v0.4.2.

Resolution is eager and fails the whole run before step 1, naming **every** missing variable at once
— CI wants one failure listing everything, not step 14 dying several LLM calls in. It runs *before*
secret collection, forced by masking-by-value (§8.3): the masker must collect the resolved token,
never the literal variable name. Ownership went the way #98 set — `@path/schema` owns the shape and
the one depth walk (`wrapper.ts`, `env.ts`, `secret.ts`), each engine reader keeps only its visitor
(`resolve-env.ts`, `secret-mask.ts`).

The audit surface tightened where the acceptance case found it thin: `RunResult.error`, and a
non-succeeded run's `output`, are now masked at the run's return. A succeeded run's output stays
real — it is the pipeline's answer, and handing an operator `[secret:key]` where it belongs would be
the wrong trade. One limit is documented rather than closed: a thrown *bug* escapes masking, because
the engine re-throws rather than swallowing it into a failed run, so its message and stack reach the
CLI's caller and the server's console unscrubbed (§8.3).

Suite 754 → 827 across the release, every existing test passing untouched at each step.

### Features

- feat(schema,engine): `$env` secret sourcing (map #113, built by #114/#115/#116/#117, docs #118) —
  `{"$env": "NAME"}` sources a config value from the environment; `{"$secret": {"$env": "NAME"}}`
  sources *and* marks secret. `mvp-spec` §10's `$env` row is retired, §8.3 carries the shipped rule,
  and format §8.3 is normative for the wrapper and the `$`-sole-key reservation. Masking stays
  by-value deliberately — "env is always secret" was rejected, because an env-sourced model name
  would get its literal string scrubbed out of every log event and input file in the run.

- feat(engine): mask what a finished run hands back (resolves #123, #124) — `path run` printed
  `run failed: ${result.error}` unmasked, so a credential that reached a failed step's stderr reached
  the operator's terminal and, in CI, the retained build log. Under `$env` the operator is frequently
  a secret store rather than a person, which is the exposure `$secret` exists to close. Masked at the
  run's return in `runWorkflow`, where the masker already lives; `@path/server`'s console is closed by
  the same change without `live-runs.ts` touching the masker.

### Fixes

- feat(engine): replay a run's narrative from `log_events` when the NDJSON backend is off
  (resolves #110) — `RunArchive.events()` read `run.log` and nothing else, so a run configured
  `log_backends: ["db"]` — a supported configuration under §8.2, not a degraded one — had no SSE
  replay at all, though every event of it was already in the table. A mid-run subscriber saw only
  what arrived after it connected, and a finished run streamed `[]`. NDJSON stays authoritative
  where it exists, so every replay in the default configuration is byte-identical to before.

### Internal

- refactor(engine): the binary step's process driver is not the run-tree walk (resolves #94) — spawn,
  stdio wiring, exit-code interpretation, SIGTERM on abort and EPIPE tolerance sat inline in the
  module that walks the run tree, while their peer for `prompt` steps had its own module. The cost
  was testability: the driver's sharpest edges — a killed child exits null and that is a cancellation,
  not a non-zero-exit failure (§5.6) — had no test that named them.

- refactor(engine,schema): withdraw the surface each deepening superseded (resolves #96) — `Project`
  owns observer and log-backend assembly, `runWorkflow` owns the run's resources, `openProject` owns
  the archive, and every ingredient of all three was still exported, so a consumer could assemble by
  hand around the owner. Two rules now stated in the index: assembly is not exported, and a seam's
  vocabulary stays even when its default adapter goes private.

- refactor(schema,engine): one owner for what a `$secret` is (resolves #98) — the sole-key rule and
  the any-depth rule were written four times across two packages; `unwrapSecret` and `isSecretWrapper`
  were byte-identical under two names, neither importing the schema that already defined the shape.
  `mapSecrets` is the one walk, and the two engine readers become the line that differs. This is what
  made the `$env` wrapper cheap a release later.

- refactor(engine): the write side of `.path/` is one module, not two (resolves #100) — a `RunStore`
  interface whose five methods were four one-line delegations, and whose seam could not be stated.
  `run-store-writer.ts` is gone; the #72 guarantees survive verbatim with their docblock, and
  `paths.ts` now spells the four blob filenames once instead of `run-archive.ts` keeping a second map
  they could disagree about.

- refactor(engine): the db log backend is one sink that knows its table (resolves #104) — a 28-line
  backend with no implementation without its store, and a 31-line store with no caller but the
  backend. Merged, and `insertLogEvent` is private, which is the point rather than a side effect: the
  sink is the only way a row reaches `log_events`, and the engine assembles the envelope, the `seq`
  and the masking before it.

- test(engine): pin node semantics at the seam, not twice (resolves #102) — #87 shipped `runNode` so
  node semantics were reachable without driving a whole run, but `run-workflow.test.ts` never shrank,
  so branch, loop, join and prompt semantics were pinned in two places. 61 cases there become 35, 24
  at the seam become 40. What is left is what only a whole run has: secret masking, nested trees,
  observer ordering, config inheritance, and the caps that span nested runs.

- test(schema): make a wire field the domain gained a compile error (resolves #107) — a new field on
  `RunRecord` failed to compile at `fromDbRow` but not at `toWireRunRecord`, so a new column could
  reach the db and never reach the API. `keyof WireRunRecord` must now equal the snake-cased
  `keyof RunRecord`; verified by adding a field to each side in turn. `WireRunRecord` stays written
  out by hand — a *derived* wire type would let a domain rename silently rename a field of the v0
  contract (server-api-v0.md §4).

### Docs

- docs(readme): status through v0.4.2 and what's open (#111) — the Status block still named v0.4.0 as
  the latest release and listed the cancellation tickets as the frontier. Now one line per release,
  the two declined review candidates named so the next reader finds them rather than re-deriving
  them, and a What's-next pointing at #109's v-next register.

### Other

- The `$env` map (#113) closed with its parked questions rehomed rather than dropped: unset vs empty
  is decided in §8.3 (`FOO=` counts as set and trips the short-secret warning; only a genuinely unset
  variable fails the run), whether a run *row* should carry its error is in §10's deferred register
  via #124, and whether a run-start failure *reads* well graduates with a viewer to look at it.

## v0.4.2 — 2026-07-28

Patch: six candidates from an architecture review, five built and one refused. v0.4.1 gave the
engine's *interior* the seams it lacked; this pass asks the same question of the parts that already
had owners and finds the things that had none. Each of the five is the same move — something the
codebase already did, done in one place instead of at every call site: reading a run back
(`RunArchive`), running one over HTTP (`LiveRuns`), framing an event on the wire
(`encodeEventFrame`), running one node of a body (`runNode`), and saying what a run's events mean
(`eventOutcome`, `buildRunTree`).

The v0 wire format, every HTTP status and the CLI's surface are unchanged, so the outward-facing
change is confined to what the workspace packages export to each other: `Project.db` is now
`Project.archive`, `@path/engine` no longer exports `getRunsForRoot`, `listRootRuns`, `readJsonBlob`
or `runBlobDir`, `@path/server` no longer exports `RunEventHub`, and `@path/schema` gains the event
stream's frame codec. Every existing test passes untouched at each step, and the suite grows 685 →
754 as the seams become reachable.

The sixth candidate — collapsing the three exhaustive switches over `Observation` behind one
per-variant table — is **not built**, and #91 records why so the next review does not re-derive it.
Investigating it found a real bug instead, which is this release's one fix.

### Fixes

- fix(engine): mask the usage a worker reports (resolves #91)

  `step-usage.usage` is a `JsonValue` supplied by the LLM worker (mvp spec §5.7, §7) and written
  verbatim to the run row. It sat in `maskObservation`'s pass-through group under the comment
  "carry only ids, counts and engine-chosen enum values" — an assumption about what a worker puts
  there, not a guarantee, and it is the one payload crossing that seam the engine neither builds nor
  validates. Token counts are numbers and numbers pass through masking untouched, so scrubbing it
  costs nothing.

  The sweep over all fourteen members asserting no secret survives could not have caught it: the
  `step-usage` sample carried no secret to begin with, so it passed vacuously. **Totality is not
  coverage** — a member can be listed in the switch and still return unmasked. A second test now
  requires every sample to hold the secret before masking, with `CANNOT_CARRY_A_SECRET` naming the
  two members that provably cannot.

### Internal

- refactor(engine): give the read side of `.path/` an owner (resolves #81) — `Project` owned
  assembling a run *into* `.path/` (#64); reading one back and deleting one had no owner, so five
  server routes and two CLI subcommands each composed the same three stores by hand. `Project.db`
  was public purely to let them, which made the engine's on-disk layout part of `@path/server`'s
  contract with nothing in the type system saying the two must move together. `RunArchive` is that
  owner: `rows.find((row) => row.runId === rootRunId)` was written four times, the blob filenames
  lived in an HTTP route, and `path runs rm` carried its own copy of the operator-error policy.

- refactor(server): give the live run one owner (resolves #83) — starting a run over HTTP was never
  one call to `Project.run`: it is a run started, an id answered before the run finishes, a
  controller filed, a live channel opened, and both torn down however the run ends. Five modules
  held a share of it and none of it was reachable without binding a port — `post-runs-registry.test.ts`
  drove a route handler with a hand-built request and response purely to reach a `Map`. Three
  guarantees that were comments a caller upheld are now `LiveRuns`' interface.

- refactor(schema): one event-frame codec, not four (resolves #85) — the framing the log stream
  travels in was written four times, and they had already drifted: one copy accepted `data:` with or
  without the space and the other three sliced a fixed six characters, so a server emitting the
  compact form would have been read by the browser client and silently ignored by everything else,
  including the acceptance harness whose job is to catch that. The same failure `wire-v0.ts` was
  created to end, one layer up.

- refactor(engine): one node seam, not five of seven (resolves #87) — #76 pulled the control-node
  walkers to module scope and stopped, leaving `branch` reachable by a test and `binary` not, though
  a body may hold either in the same position. `runParallelNode` was exported with no direct caller
  anywhere. `runNode` owns everything about one node — which of the seven kinds it is, its config,
  its input, its publish — and the four kinds that had no direct test now have one.

- refactor(client-core): the run's meaning belongs to the core (resolves #89) — a package documented
  as "the core every viewer/designer/mobile surface consumes" could not tell a surface which events
  mean a run stopped, or which run spawned which. Both moved; `eventMessage`, `nodeLabel` and
  `STATUS_GLYPH` stayed, because English copy and glyphs are where a second surface differing is
  correct rather than drift.

### Other

- docs: candidate 6 declined and the reasoning recorded (#91) — the three switches ask three
  different questions, the table would need four field-kind categories plus an escape hatch for
  `step-finished` alone, and locality gets worse: one file per policy becomes one row spanning three
  concerns. The review's premise was also wrong on a fact — `test/fake-observer.ts` is
  compile-checked, not an unguarded fourth copy.

## v0.4.1 — 2026-07-27

Patch: one leak fixed, and the interior given the seams the cancellation phase kept revealing it
lacked. v0.4.0's acceptance run found its bugs by running the whole system, because there was no
smaller thing to run — `run-workflow.ts` had three exports and no internal joints, five recursions
walked the same node tree, and the condition language was implemented once to validate and again to
evaluate. Seven refactors close that gap. The public surface does not move: `runWorkflow`,
`RunOptions`, `RunResult` and the v0 wire format are unchanged, and every existing test passes
untouched at each step — 630, 653, 663, 685 as the suites grew.

Two changes are visible from outside despite the patch number, both consequences of #64, and both
documented in `docs/api/server-api-v0.md`: API-launched runs now honour `.path/settings.json`, which
they never did though the API doc has always described the request fields as "Same as `path run`";
and a malformed settings file now fails server startup rather than being skipped.

`@path/client-core` also stops depending on `@path/engine`. A package documented as "pure-TS,
zero-framework" carried a runtime edge to one shipping better-sqlite3, `node:child_process` and the
Agent SDK, for five `import type`s naming two pieces of domain vocabulary. Its `dependencies` is one
entry now.

### Fixes

- fix(server): close the live channel where the run's controller is dropped (resolves #74)

  Two registries tracked one live run and only one was torn down where the run ends. The controller
  registry was dropped in `post-runs.ts`; the hub channel was opened and closed by the live-forwarding
  backend, off the root run's `run-started`/`run-finished` — nothing the server controls.
  `runWorkflow` drives `run-finished` on every path it controls, so normal and failing runs both close
  cleanly. The gap is the path it explicitly does not control: "any other thrown error is a bug and
  propagates". No terminal event, so `close` never runs, the channel outlives the run, and every
  subscribed SSE client hangs open forever — `res.end()` is wired to the channel's close listener. The
  `.finally()` that already existed to make cleanup true by construction now tears down both.
  Verified against the defect: reverting the two added lines turns both leak tests red.

### Internal

- feat(engine): a Project module owns the run assembly (resolves #64) — running one workflow correctly
  took five modules wired in a required order, and the three callers that did it by hand disagreed.
  Three things stop being *possible* rather than stop being wrong: the directory pair (#59 is no
  longer expressible — no call site supplies both `projectDir` and `workflowDir`), the
  persistence-before-logging observer order, and the settings precedence rule.

- refactor(schema): own the runtime vocabulary, not just the workflow format (resolves #66) — schema
  was the source of truth for what an *author* writes; nothing owned what an *execution* produces, so
  `RunStatus` lived in the SQLite module, `LogEvent` beside the log backends, and the v0 wire record
  was declared five times. The server encoded it and the client decoded it from structurally unrelated
  types in packages with no dependency between them, agreeing only by a prose comment — a renamed
  field type-checked on both sides and broke at runtime in the browser.

- refactor(schema): one condition grammar, not half a module in each package (resolves #68) — the
  `${}` tokenizer existed twice and the engine's copy was correct only because the validator had run
  first, with nothing enforcing that order; an unvalidated string got a silently truncated result
  instead of an error. One tokenizer, one dot-path walk, one operator list, one declaration per root
  set.

- refactor(schema): one walk over the node tree, not five (resolves #70) — four of the five recursions
  ended in `default: break`, so a new block type was silently skipped by id-uniqueness,
  publish-collision and `workflow`-ref scanning rather than rejected. Verified by simulation: adding a
  `wait-one` block type produces **0 compile errors before, 2 after**.

- refactor(engine): a run store of run facts, not an insert-then-update dance (resolves #72) —
  recording one run took four calls in a required order, written out three times. The blob path and
  the row's ref were built separately from the same pieces, one with the host separator and one always
  forward slashes; a mismatch left the bytes on disk and the row pointing elsewhere, with no error and
  no failing test.

- refactor(engine): give the node walk a real interface (resolves #76) — four overlapping context bags
  become two plus a composition of them, and the walkers move to module scope so `runBranchNode`,
  `runWhileDoNode` and the rest can be called directly. `merge-config.ts` (11 lines of object spread)
  had a unit test while the branch, loop and join semantics carrying mvp spec §5.2–5.6 did not; they
  do now.

- refactor(engine): the Observation union, and one required `observe()` (#62) — a partial adapter no
  longer compiles, so masking cannot be applied to some of the seam and not the rest.

### Other

- ci: `pnpm typecheck` and the full test suite run on every pull request to `main`, on Node 22 with
  the pinned pnpm from `packageManager`.
- chore: `main` is protected — PR-only, `test` required green. A tracked `.githooks/pre-commit`
  refuses a commit made on `main`, since one made there could never be pushed anyway.
- docs(context): Observation defined, and Log event as its narrated subset (#62).

## v0.4.0 — 2026-07-26

The **cancellation** phase (`docs/delegation-plan-cancellation.md`): stopping a run in flight from the
CLI, the API and the viewer — the first verb the system offers that changes a run rather than reading
one. A cancelled run ends `cancelled` — a status distinct from `failed`, because an operator stopping
a run is not the workflow breaking — lands no publishes, and is narrated by a `run-cancelled` event
carrying its `cause` (`operator` or `sibling-failed`).

One abort reaches the whole tree: `RunOptions.signal` threads to every descendant run and leaf step,
so the engine kills live child processes and tears down in-flight Agent SDK sessions alike. The unit
of cancellation is the root run only. The surfaces are all thin over that one engine capability —
`^C`, `POST /v0/runs/:root_run_id/cancel`, `cancelRun()`, a button — which is why the acceptance run
(#57) is what counts as evidence rather than any of their unit tests.

### Features

- feat(engine): external abort — cancel a root run in flight (#52)
- feat(engine): graceful `^C` — cancel the run in flight, not the process (resolves #53)
- feat(server): cancel route — `POST /v0/runs/:root_run_id/cancel` (resolves #54)
- feat(client-core): `cancelRun()` — the seam's first write verb (resolves #55)
- feat(viewer): Cancel button — the console's first verb (resolves #56)

### Fixes

- fix(server): resolve a nested workflow ref against the workflow's own directory (resolves #59)

  `POST /v0/runs` passed the server's project directory as `runWorkflow`'s second argument, which is
  not the project directory at all — it is the root workflow file's own directory, and the engine
  resolves nested `workflow` refs and binary `cwd`s against it. The CLI derives its project dir from
  the workflow file, so the two are always equal there and nothing caught the difference until a
  workflow ran through the server from a subdirectory. The test needs a fixture that is *not* at the
  project root; a root-level one cannot fail.

- fix(engine): the `runs` subcommands must reject input they do not understand (resolves #61)

  `runs prune` discarded whatever followed it, so `path runs prune --help` deleted every run in the
  project instead of answering. `path run` has rejected unrecognized arguments all along; the
  destructive verb being the lax one is backwards. `prune` now takes no operands and `rm` exactly one
  (a second id was previously dropped in silence), and `--help` is answered before dispatch so it can
  never be read as an operand.

### Docs

- docs(spec): record what a forced second `^C` costs, and accept it (resolves #60)

  The engine has no force path, but the CLI's second `^C` forces the *process*, abandoning the unwind
  wherever it had got to: rows keep their last status, the terminal `step-finished` is never written,
  the backends never close. That is the lying `running` row §5.6 says cancellation avoids, and
  nothing reconciles it afterwards — resume of interrupted runs is out of scope. Accepted as the
  price of the escape hatch rather than fixed, since making the force path wait for writes would
  defeat it. §5.6 now says so, and the `^C` notice names both the cost and the remedy
  (`path runs rm`) at the moment the operator is deciding whether to press again.

### Other

- refactor(engine): fold a leaf step's cancellation tail into one helper
- refactor(server): the cancel route must not read terminality off a non-root row
- refactor(server): keep the controller registry out of the public API (#54)
- test(client-core): `waitFor` a condition, not a microtask count (resolves #58) — `settle()` drained a
  fixed ten microtasks, which was not a timeout but an assertion about how many `await`s deep the
  production promise chain ran, vetoing refactors in files the test does not name.

- **Acceptance: the release-notes pipeline cancelled mid-fan-out, through the API and under the CLI**
  (#57). Agent SDK worker, real spend. Both live `prompt` processors took the abort: each got its own
  `run-cancelled` with `cause: "operator"` and `cause_run_id: null`, a `cancelled` `step-finished`, and
  a root terminal `step-finished` with the backends closed. `context.json` held only `raw_changes` —
  neither cancelled step's publish landed. Under the CLI, one `^C` unwound in 2.6s and exited **130**;
  a second `^C` during the unwind exited in 0.02s. The viewer's pill read cancelled, both narrative
  lines read "cancelled by the operator" with no phantom sibling run id, and a reload replayed the
  terminal state from the NDJSON.

  What the pass turned up, which is the part worth writing down:

  - **The first attempt never cancelled anything.** The pipeline died at `revise-loop` on
    `referenced file "./revise-cycle.workflow.json" is not in the loaded tree`, and the operator's
    click hit an already-`failed` run. `POST /v0/runs` passes the server's project root where
    `runWorkflow` expects the workflow file's own directory, so no server-run workflow outside the
    project root can resolve a nested ref. Filed as **#59**; the CLI derives the directory correctly,
    which is why this survived to acceptance.
  - **A forced second `^C` leaves a lying `running` row** — root and both leaf runs frozen, no terminal
    events, backends never closed. That is the exact state `mvp-spec.md:191` says cancellation exists
    to prevent, reintroduced by the escape hatch, and nothing reconciles it afterwards. Filed as
    **#60**.
  - **The fan-out window is about five seconds wide**, so the cancel had to be fired by a poll loop
    rather than a human click — `gather-changes` is a local `git log`, and both summarize prompts
    return fast. The trigger was the same `POST /v0/runs/:root/cancel` the button calls, so the code
    path under test is unchanged, but no operator will hit this window by hand. Two live processors is
    also the ceiling this pipeline offers, not an arbitrary "several".
  - **The old-log replay proves less than the ticket assumed.** The one persisted v0.3-era log in the
    repo carries zero `run-cancelled` lines, so replaying it cannot exercise `cause`'s default. It
    replays clean through `readNdjsonLog` — 16 events, no schema error — and that is all it shows. The
    default itself rests on `packages/engine/test/logging/log-event.test.ts:53`.
  - The root run carries no `run-cancelled` of its own, only its `cancelled` `step-finished`. By
    design: `logging-observer.ts:113` scopes the event to the cancelled *step* run, and the root is a
    workflow-run. Recorded so it does not read as a gap later.

## v0.3.1 — 2026-07-25

Patch: the node-I/O pane could hide an output object that exists. Found by running the LLM-backed
release-notes acceptance pipeline through `path-server` and watching it in the viewer — the pass
v0.3.0 shipped without.

### Fixes

- fix(viewer): show a finished run's output when its ref arrived after the last tree read (resolves #51)

  v0.3.0 decided blob absence from the run record's `input_ref`/`output_ref` rather than from a 404,
  since the route 404s for an unknown root, a run outside the tree and a missing file alike. But refs
  only enter the snapshot through a tree read, and the tree is re-read only when the stream discovers
  an *unknown* run — never because a known one finished. Nothing follows the last node of a tree, so
  its refs never arrived: the pane claimed "no output object yet" about a finished step, and Refresh
  could not help, because a null ref skipped the request entirely. Absence is now decided by whichever
  source cannot lie: a **running** run with no ref is still not asked, a **terminal** one is asked
  regardless and its 404 is trusted.

### Other

- Acceptance: the **release-notes pipeline** (Agent SDK worker, `v0.2.0..v0.3.0`) driven end-to-end
  through the API and watched in the viewer — parallel LLM fan-out with a collect join, the
  judge-step pattern, a `while-do` that exited on a passing verdict, a branch, and a real
  `RELEASE_NOTES.md` on disk. Retires the deviation recorded against map #40; the nested
  `revise-cycle` workflow stayed unexercised, the judge having passed the draft first time.

## v0.3.0 — 2026-07-25

The **MVP viewer** map (#40): a read-only web monitor for a live `path-server`. Two new packages —
`@path/client-core`, the pure-TS core every future surface consumes (typed API client, SSE client
with `Last-Event-ID` resume, run view-model; zero framework imports), and `@path/viewer`, a React
web view over it. Four read verbs, no more: **list, open, watch, inspect**. `@path/server` grew the
two things the map allowed — static serving for the built bundle, and a blob route so a browser can
read a run's input/output objects it cannot reach on the server's filesystem.

### Features

- feat(client-core): pure-TS core — API client + SSE with `Last-Event-ID` replay + run view-model (resolves #41)
- feat(server): static file serving + SPA fallback — one process, one origin, no CORS (resolves #42)
- feat(server): `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — a run's input/output object, already masked (resolves #43)
- feat(viewer): scaffold the React app shell — Vite + dev proxy + core wiring (resolves #45)
- feat(viewer): runs-list surface + the three-pane console frame (resolves #46)
- feat(viewer): run-detail surface — root-run status + live indented run tree (resolves #47)
- feat(viewer): live-narrative surface — `seq`-ordered SSE event stream + stream liveness (resolves #48)
- feat(viewer): node-I/O surface — a run's masked input/output objects as mono JSON, with their blob refs (resolves #49)

### Fixes

- fix(viewer): re-read the runs list, which never refreshed after mount — a finished run kept reading as running while the live centre pane disagreed (resolves #50)
- fix(viewer): run-row legibility against real run ids and the dark theme
- fix(server): await child exit before `rmSync` in the bin e2e teardown

### Docs

- docs(api): document the blob route as server-api-v0 §4.1, closing the "no blob-serving endpoint in v0" gap
- prototype(viewer): layout + design-token exploration — pinned Variant A (three-pane console) and the token set (#44)

### Other

- refactor(viewer): share the loading and failure notes across the read surfaces
- refactor(viewer): apply code-review fixes to the runs-list surface
- refactor(client-core): drop dead `readFrames` return, dedupe the default fetch
- refactor(server): use `path.extname` in the serve-static content-type lookup
- Dogfood: all five map-#40 criteria walked in a browser against a live `path-server` — list, open,
  live tree + narrative, mid-run reload replaying with no gap, and node I/O (including a running
  node picking its output up unprompted when the run finished). Driven by the local `changelog`
  workflow and a purpose-built `slow-demo`, **not** the LLM-backed release-notes pipeline.

## v0.2.0 — 2026-07-21

The **`@path/server`** map: `@path/engine` becomes reachable over HTTP. A new package exposing a
v0 HTTP + SSE API (4 endpoints) and a `path-server` CLI, an in-process wrapper that adds no engine
capability — the door mvp spec §10 held open for "Website/cloud, remote engines, mobile".

### Features

- feat(server): `@path/server` walking skeleton — boots + `POST /v0/runs` + `GET /v0/runs/:root_run_id` (resolves #35)
- feat(server): `GET /v0/runs` — list root runs (resolves #36)
- feat(server): `GET /v0/runs/:root_run_id/events` — live SSE stream of a run's narrative (resolves #37)
- feat(server): SSE reconnect/replay via `Last-Event-ID` + NDJSON — a dropped client resumes with no gap (resolves #38)
- feat(server): §5 acceptance harness — release-notes pipeline driven end-to-end through the API, all four spec §5 criteria confirmed on a real run (resolves #39)

### Docs

- docs(spec): PATH server API v0 — endpoint contract + assembled spec (resolves #29–#34)

### Other

- refactor(server): dedupe SSE header write in get-run-events
- refactor: derive `RunStatus` from a single `RUN_STATUSES` const
- Dogfood: changelog workflow, run end-to-end on this repo

## v0.1.0 — 2026-07-21

The MVP (map #1): `@path/engine` + `path` CLI runs the release-notes acceptance pipeline
end-to-end on macOS.

### Features

- feat(engine): engine-settings file for log.backends + LLM cap (resolves #27)

### Fixes

_None_

### Other

- docs(acceptance): drop valid-json from the coverage map
- refactor(engine): tighten the acceptance suite on code review
- RALPH: acceptance — release-notes pipeline end-to-end (resolves #26)
- docs(spec): record engine-settings file as follow-up (#27)
- RALPH: LLM worker — Agent SDK prompt steps, fan-out cap, usage/cost (resolves #25)
- Merge sandcastle/issue-23: while-do loops
- test(engine): cover interpolated while-do max_iterations resolution
- RALPH: while-do loops — condition-checked iteration block (resolves #23)
- refactor(engine): clarity cleanups on the parallel-block review
- RALPH: parallel collect join + best-effort cancellation (resolves #24)
- refactor(engine): extract negate helper from nested ternary in condition eval
- RALPH: conditions, checkpoint, branch — control constructs (resolves #21)
- REFINE: swallow stdin EPIPE in runBinaryStep (#20 review)
- RALPH: secret masking at the persistence boundary (resolves #20, mvp spec §8.3)
- PATH add README.md
- refactor(engine): name parseLogBackends result type for cli.ts consistency
- RALPH: logging — typed event stream, LogBackend seam, db + NDJSON backends
- REFINE: drop dead param, align node-handler naming (#22)
- RALPH: Nested workflow steps — workflow-as-step + run tree (resolves #22)
- PATH: submit the fix for sandcastle
- PATH: add sandcastle
- @path/engine: persistence — run records + blobs under .path/
- @path/engine: runtime data flow — ${} interpolation, input/publish, config, parse:json
- @path/engine: walking skeleton — path run executes a sequential binary workflow
- Address code-review findings on @path/schema
- @path/schema: workflow format v0 types + validation, monorepo scaffold
- PATH: add delegation-plan-implementation.md
- MVP spec: coherence-grilling amendments before sign-off
- Add MVP spec: assembly of all map #1 decisions (resolves wayfinder ticket #12)
- PATH: add the delgation plan for specification plan process
- CONTEXT.md: audit vocabulary — log events, traces, backends, secrets (resolves wayfinder ticket #14)
- Add workflow file format v0 spec; acceptance workflow rewritten in v0 (resolves wayfinder ticket #10)
- Add acceptance workflow sketch: repo release-notes pipeline (resolves wayfinder ticket #9)
- Add Agent SDK spike findings (resolves wayfinder ticket #13)
- Add LLM worker execution options survey (resolves wayfinder ticket #6)
- CONTEXT.md: nested block grammar + MVP logicer subset (resolves wayfinder ticket #5)
- Add CONTEXT.md: PATH domain model glossary (resolves wayfinder ticket #2)
- Path: add brainstorm.md

