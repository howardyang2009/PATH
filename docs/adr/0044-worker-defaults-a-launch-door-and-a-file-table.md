# Worker-defaults: a launch door and a file table, below an explicit `worker`

A step's worker resolves in four tiers, first hit wins:
`node.worker ?? launchWorkerDefault[type] ?? fileWorkerDefault[type] ?? plugin.defaultWorker`.
A **worker-default** is a `{ <type>: <worker-name> }` table that picks which worker a type's *un-pinned*
steps use, chosen among that type's already-scanned workers **by name**. It names no code, so it is an
**operator** affordance, a different door from host-only `workerOverrides`, which replaces the *code* of a
`(type, name)` pair (ADR 0021 sub-15). The two tables differ by tier and by lifetime: a **file
worker-default** is authored as a top-level `worker_defaults` key on a workflow file, is **file-scoped**
(it never crosses into a nested `workflow`-ref file), and is **live** (re-read from the current file on
resume); a **launch worker-default** is supplied by the operator at launch, is **run-wide**, and is
**frozen** with the run.

## Shapes

- **CLI**: a repeatable `--worker-default <type>=<name>` (peer of `--set`, not folded into it).
- **Server**: a top-level `worker_defaults: { <type>: <name> }` field on `POST /v0/runs`, beside `input`
  and `config`, **not** inside `config`.
- **Merge**: shallow, per type. `{prompt: deepseek}` at launch leaves every other type's file/type
  resolution untouched.
- **Validation**: both tables are checked at load, registry-relative — but through **two channels**, one
  per tier (#506, see "Validation site" below). A key naming an absent type, or a worker a type does not
  ship, is rejected against the run's one registry.

## Persistence and resume

The launch worker-default is stored on the **root run** and read back on resume, so a re-run step
(K-and-after) resolves to the same worker it would have at launch — determinism the audit's recorded
`worker_name` depends on. It behaves like **input**: identity-defining, frozen, restored from the run, so
the resume route carries **no** `worker_default` field at all (as it carries no `input`). Only operator
**config** stays re-overridable on resume. Changing the launch worker-default or the input is a new run,
not a resume. The **file** table is *not* persisted: it is authored data, re-read from the current file,
so an author's edit between launch and resume changes only re-run steps, never the reused rows below K —
the same file-is-authority stance as person-activity's `outputSchema` (ADR 0040).

## Scope and determinism: nesting, resume, replay

**Nesting.** A **file** worker-default is file-scoped: it never crosses a `workflow`-ref boundary, so a
parent file's default does not reach a child, and each ref-file authors its own. A **launch**
worker-default is run-wide: it reaches every un-pinned step of every file in the run, child files
included. When both apply to a child's step, the tier order decides — **the launch default beats the
child's file default** (`node.worker` → launch → file → type). This is deliberate: the operator's
run-wide launch intent outranks an author's per-file *default*. The only thing above a launch default is
a hard `node.worker` pin on the step; a child author who must force a worker pins the node, not the file.
There is no per-file opt-out from a launch default, by design.

**Resume.** A resumed run re-reads the workflow file, so the **file** default is live: an edit between
launch and resume changes only re-run steps (K-and-after). The **launch** default is frozen on the root
run and restored, so the resume does not change it. A re-run step resolves from the frozen launch default
plus the live file, exactly as it would at launch.

**Replay / complete.** Determinism below the rerun boundary K comes from read-only reuse, not from
re-deriving anything: a `succeeded` run row is reused verbatim (`planReuse`), so a completed step keeps
its recorded `worker_name` and is never re-resolved. Only steps at/after K execute fresh and re-resolve,
from the frozen launch default and the current file. So a predecessor (reused, below K) and a successor
(re-run, at/after K) may legitimately resolve to different workers if the file default changed — the
live-file stance, not a fault. A completed step's worker is a recorded fact; replay reconstructs it per
row, not as a set.

## Validation site: two channels, one per tier (#506)

Both tables validate registry-relative, but not through one `workerOverrides`-style throw. A
`workerOverrides` entry names author-trusted code and is host-only, so its unknown-type/unknown-worker
check throws at registry resolution (`run-workflow.ts`). A worker-default is a *selection*, and its two
tiers are authored by two different parties in two different places, so they fail in two different places.

- **File table → file-invalidity.** The file `worker_defaults` is authored file data, the same class as a
  node's `worker` pin. Its registry-relative check is a **registry-fed refinement at engine load**, not a
  throw and not the registry-agnostic base file schema (`z.record(string,string)` stays shape-only). A bad
  entry makes the *file* invalid, so **discovery** reports it invalid and the **Designer refuses to open
  it** (ADR 0026), beside an unknown `node.worker` or an unknown step type. The author sees it at author
  time. The pane already blocks an invalid `{ type, worker }` pair, but a hand-edited file bypasses the
  pane, so the load-time net is what catches it. This holds even while the file table is **inert** (the
  sequencing note below): the check ships with the schema key, so an inert table that names a bad worker
  still fails to load rather than round-tripping unchecked into a later trap.
- **Launch table → launch boundary.** The launch `--worker-default` / `POST /v0/runs` field is operator
  input, authored in no file and seen by no Designer. A bad entry is a **bad request**, not an engine
  fault: the CLI exits non-zero and the server returns **`400`** before the run starts. The operator fixes
  their own launch; an author cannot, and need not, fix an operator's flag.

The asymmetry is the point of #506's third question. The file author is caught at author time because the
file surfaces are the ones that read the file; the operator is caught at launch time because that is the
only surface their input passes through. Same taxonomy, different site, because the two tiers have
different authors.

**Nesting.** The registry is one, run-wide. Every discovered file (root and each nested `workflow`-ref
file) validates its **own** file-scoped table against that one registry, so a bad child table invalidates
the *child* file, not its parent. The launch table validates **once**, run-wide, at the launch boundary.

**Error taxonomy.** Two failure classes, each channel:

- **Absent type** — echoes the named type, lists the installed types, names the remedy (a plugin folder in
  the reader's own tree), like the unknown-`type` node error (`run-workflow.ts`). It fires even when no
  node uses the type: the table names it, so the table is wrong.
- **Type present, worker absent** — lists the type's shipped worker names, like the `node.worker` enum
  error (`nodes.ts`).

Each error prefixes its **source** — `worker_defaults in <file>: …` versus `--worker-default: …` — so the
reader knows where to fix it. Both channels **aggregate**: one verdict names every bad entry across the
table (the file report folds them in beside a bad `node.worker`/unknown type, like an unset `$env`
naming every missing variable), never first-entry-only as the `workerOverrides` throw does.

## Considered options

- **Reach it through `config` (`--set worker_defaults.prompt=deepseek`).** Rejected: config *inherits*
  and carries operator-variable data like `model`; worker selection explicitly does **not** inherit and is
  type-scoped (CONTEXT.md invariant 5). Folding worker selection into config erases that line.
- **Extend host `workerOverrides`.** Rejected: `workerOverrides` names author-trusted *code* to replace
  ("to add one is to edit the engine"), host-only. A run default only *selects* a scanned worker by name
  and is safe for an untrusted browser operator. Different trust class, different door.
- **Launch default beats an explicit `node.worker`.** Rejected: a node's `worker` is a deliberate author
  pin; overriding it silently repoints a named step to a different method — the hazard ADR 0021 rejected
  for the codemod. The launch table fills only steps that named none.
- **Freeze the file table on the run too.** Rejected: it needs a second persisted map and makes the file
  lie about what a re-run does; file edits are explicit and git-visible, and touch only re-run steps.
- **One `workerOverrides`-style throw for both tables (#506).** Rejected: it fails the file author only at
  run/launch, past discovery and past the Designer, though the file table is authored file data that those
  surfaces read. Splitting the channel by tier catches the file author at author time (file-invalidity)
  and the operator at launch time (`400`), each at the only surface their input passes through.

## Invariant 5: reframed, not breached

#309 fixed *no worker inheritance* as a keystone (ADR 0021), and #503 asks whether a run-level default
breaks it. It does not. Inheritance flows a *value* from an enclosing node to its children by tree
position; a worker-default is a *selection* — a type-scoped name chosen among a type's already-scanned
workers, keyed by type, not by position. #309's reason — a worker name is meaningless across types —
holds unchanged. So invariant 5 is **narrowed** (selection gains tiers: `node.worker` → launch → file →
type default), not deleted. The file tier shows this by staying file-scoped; the launch tier reaches
every file of the run yet is still selection, because the operator sets one flat per-type table for the
whole run, not a value the parent file hands to a child. The breach reading — that #309 was wrong and
invariant 5 must be rewritten — is rejected.

## Designer surface (v1)

The **file** worker-default is authored data, so the Designer surfaces it. The **launch** worker-default
is operator-launch-time, authored in no file, so the Designer never shows it (#505).

- **WorkerSelect ghost.** The node worker dropdown shows the *effective* resolution for an un-pinned step,
  not the raw type default. A leading **"(default)"** option drops `node.worker` (stays un-pinned) and
  names what that resolves to and from which tier — `(default: <worker> — file)` when the file table pins
  the type, else `(default: <worker> — type)`. Picking a concrete worker pins `node.worker`; picking
  "(default)" un-pins. This mirrors the `config.model` inherit ghost (`ModelField`).
- **File-properties editor.** A `worker_defaults` region on the file properties: rows of `type → worker`,
  both constrained dropdowns (type from registry types shipping more than one worker; worker from that
  type's set), so an invalid `{ type, worker }` pair cannot be authored in the pane.
- **No wire or node-floor change.** `toWireStepPlugins` already ships `workers` + `default_worker`, so it
  does not change. `ENVELOPE_KEYS` governs *node* field names and is untouched — `worker_defaults` is a
  *file* top-level key. The only schema change is `workflow-file.ts`, whose strict top-level gains an
  optional `worker_defaults: { <type>: <name> }` beside `config`. Registry-relative validity (unknown
  type, or a worker a type does not ship) is checked at **engine load**, not in the registry-agnostic
  file schema.
- **Sequencing.** The Designer surface and the file schema key ship first (#505). Until the engine's
  four-tier resolution lands, an authored `worker_defaults` is **inert**: it validates and round-trips,
  but the engine still resolves `node.worker ?? plugin.defaultWorker`. The pane must not claim otherwise.

## Viewer surface (v1)

The launch tier's operator door is the **Viewer's launch form**, next to `input` and the config
override: a collapsed `Launch worker defaults (optional)` field holding the same `type → worker` rows,
over the step-plugin registry the panel reads from `GET /v0/step-plugins` (ADR 0019). It is the same
editor component the Designer binds to the file's `worker_defaults` — one implementation, two tiers,
because the *editing* is identical even though the lifetime and scope are not. The field is absent
when the registry ships no multi-worker type (nothing to select), and an empty table is omitted from
the body rather than sent as `{}`, matching the file channel's drop-empty-key rule.

## Consequences

- The `runs` root row gains a persisted launch-worker-default map; the `POST /v0/runs` body and the CLI
  gain one field/flag each; the workflow file schema gains a top-level `worker_defaults` key.
- CONTEXT.md adds **worker-default** (with **file** and **launch** tiers), rewrites **default worker** as
  the bottom of a four-tier resolution, and updates invariant 5.
- The resume route is unchanged in shape: it still takes only `config` and `rerun_from_run_id`.
- The file table's registry-relative check is a registry-fed load-time refinement surfaced as
  file-invalidity (discovery + Designer, ADR 0026); the launch table's is a launch-boundary `400` / CLI
  non-zero (#506). Both aggregate every bad entry and prefix their source.
- The Designer gains a `worker_defaults` file-properties region and an effective-default ghost on the
  worker dropdown; `toWireStepPlugins` and `ENVELOPE_KEYS` are unchanged (#505). The Viewer's launch
  form gains the **launch** table's editor over the same region component, so each tier has one
  authoring surface and they share one implementation.
