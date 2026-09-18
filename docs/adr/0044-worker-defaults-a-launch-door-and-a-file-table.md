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
- **Validation**: both tables are checked at load, registry-relative. A key naming an absent type, or a
  worker a type does not ship, is a hard load error naming both — the same replace-only discipline as
  `workerOverrides` (`run-workflow.ts`).

## Persistence and resume

The launch worker-default is stored on the **root run** and read back on resume, so a re-run step
(K-and-after) resolves to the same worker it would have at launch — determinism the audit's recorded
`worker_name` depends on. It behaves like **input**: identity-defining, frozen, restored from the run, so
the resume route carries **no** `worker_default` field at all (as it carries no `input`). Only operator
**config** stays re-overridable on resume. Changing the launch worker-default or the input is a new run,
not a resume. The **file** table is *not* persisted: it is authored data, re-read from the current file,
so an author's edit between launch and resume changes only re-run steps, never the reused rows below K —
the same file-is-authority stance as person-activity's `outputSchema` (ADR 0040).

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

## Consequences

- The `runs` root row gains a persisted launch-worker-default map; the `POST /v0/runs` body and the CLI
  gain one field/flag each; the workflow file schema gains a top-level `worker_defaults` key.
- CONTEXT.md adds **worker-default** (with **file** and **launch** tiers), rewrites **default worker** as
  the bottom of a four-tier resolution, and updates invariant 5.
- The resume route is unchanged in shape: it still takes only `config` and `rerun_from_run_id`.
