# Source comments state what and why; decisions live in ADRs

**Status:** accepted. Tracked by [#644](https://github.com/howardyang2009/PATH/issues/644).

## Context

Source files carried so much prose that a reader worked through paragraphs to reach a few lines of
code. Measured across `packages/*/src`, comment lines ran 37% (engine), 36% (schema), 35%
(client-core) and 31% (server); `run-workflow.ts` was 49%, `run-context.ts` 64%. That prose
duplicated material the repo already keeps elsewhere: ADR citations, issue numbers, module-history
("four overlapping context bags became these two"), and rejected alternatives that ADR 0001–0064
record. Most of the code is agent-written, and the lever that reaches those authors is the coding
standard: `.sandcastle/CODING_STANDARDS.md` said only "comments explain constraints, not mechanics,
and cite spec sections where relevant", which was read as "cite everything".

## Decision

A comment states **what** the code does and any **non-obvious why**, in at most ~3 lines.

- History ("used to be"), rejected alternatives, and issue numbers (`#123`) do not go in source; they
  go in the ADR or the commit message.
- Cite an ADR or spec section only when the code would look wrong without it, and never as a
  comment's only content.
- Comment lines stay under 20% of a package's `src/`. Enforced in review, stated in
  `.sandcastle/CODING_STANDARDS.md` and `CLAUDE.md`.
- `packages/*/src` carries no issue numbers.
- A decision whose only record was a comment moves into an ADR; the ones that no existing ADR
  covered are recorded under "Rationale moved out of source" below.

## Considered Options

- **Trim every package in one change** (chosen). The prose is a property of the codebase, not of the
  files a later change happens to touch; a file-by-file trim would leave the worst files (the ones
  nobody edits) at 50% for another year.
- **Delete the history and rejected alternatives outright.** Rejected. It is the only record of
  several drift-guards — a `Set` where `Object.hasOwn` is required, a wire type that must not follow
  a domain rename. They are recorded below instead.
- **Keep one ADR citation per claim.** Rejected. 801 citations in `src/` made every file cite
  everything and nothing; a citation now appears only where the code alone would read as wrong.
- **Keep the issue's file-by-file sequencing.** Rejected as the vehicle for this change — a
  package-wide ratio cannot be reached that way, so [#644](https://github.com/howardyang2009/PATH/issues/644)'s
  acceptance target is the one adopted — but kept as the ongoing rule: a future edit must keep its
  package under the target rather than re-add prose.

## Consequences

- Comment share after this change: engine 36.9% → 19.0%, schema 36.3% → 17.9%, client-core 35.2% →
  19.4%, server 31.0% → 16.2%, designer 22.9% → 14.1%, viewer 20.9% → 13.9%. Issue numbers in
  `packages/*/src`: 655 → 0. 9,115 lines removed, 3,093 added, across 234 files.
- **No behavior changed.** Every changed file's source is identical to its predecessor once comments
  are removed, and the full test suite and typecheck pass.
- **The rationale below is now the home for these claims.** When one of these decisions changes, it
  changes here (or in the named ADR), not back in the comment it came from.

## Rationale moved out of source

Entries that no existing ADR records, or that an existing ADR covers only in part. Grouped by
package; the file is where the constraint applies.

### `@path/engine`

- `src/controllers.ts` — A `branch` with no matching arm and no `else` fails the run instead of
  falling through to a no-op: silent fall-through would hide authoring bugs (mvp spec §5.2).
- `src/continuation.ts` — A Complete replay re-enters a non-terminal row only for a nested `workflow`
  step or a loop iteration container; a leaf row (cancelled or failed included) runs fresh, because a
  parked tree has no live leaf row and a cancelled row is not resumable.
- `src/descend-node-path.ts` — Node-id descent and ref-relative file resolution live in the engine,
  not `@path/schema`: schema owns no filesystem concern, not even path math (ADR 0018 covers the
  purity, not this placement).
- `src/persistence/complete-lease.ts` — The Complete lease has no session identity and no takeover: a
  short-lived holder token, with an expired marker reclaimed lazily by the next Complete, unlike the
  Designer's `session_id` lease (ADR 0017).
- `src/persistence/persisted-observer.ts` — A run's blob directory and the row's blob ref are produced
  once, by the write that creates the bytes. The two address the same file with different separators
  and nothing checks them against each other, so a mismatch would strand the blob with no error.
- `src/plan-reuse.ts` — A resumed `wait-one` race with two `succeeded` branches picks the winner by
  recorded completion time, breaking an exact tie by declaration order; the live run's `seq` ordering
  is not on a `RunRecord`, and first-declared would land a different branch.
- `src/project.ts` — One module owns the whole run assembly (settings load, db open, backend
  selection, persistence-before-logging observer order), because the three hand-rolled assemblies had
  crossed the project and workflow directories and skipped `.path/settings.json`.
- `src/project.ts` — `Project` exposes a `RunArchive` reader rather than the raw better-sqlite3 handle
  it writes through, so no reader composes `.path/`'s layout for itself.
- `src/ref-tree.ts` — One `walkRefTree` descent owns nested-`ref` resolution and effective-config
  threading, and the caller supplies the run's environment snapshot: a reader defaulting to
  `process.env` would judge a node against config the run never used.
- `src/run-archive.ts` — `RunArchive` owns the read and delete sides of the `.path` layout and
  deliberately knows nothing about HTTP status codes, exit codes, or which null means 404.
- `src/run-context.ts` — `NodeWalk` is threaded through the run context rather than imported by
  constructs; importing `runSequence` back from the executor formed the
  `run-parallel` → `run-workflow` → `runNode` → `runParallelNode` function cycle.
- `src/run-emitter.ts` — The shared `Observation` envelope is computed once per run in the `Emitter`
  rather than hand-built at each of the ~28 emit sites.
- `src/run-observer.ts` — The audit seam is one required `observe()` per `RunObserver`, not one
  optional hook per lifecycle point: a partially-implemented forwarding decorator silently deleted 8
  of 14 observation kinds, and the partiality was unenforceable.
- `src/run-observer.ts` — `composeObservers` fans out in the order handed to it, and `Project.execute`
  fixes that order as persistence → logging → appended. A logging failure aborts the remaining
  observers, so the row must land first and the appended capture observer must run last.
- `src/run-start.ts` — Run start collects config objects across the whole reachable tree and checks
  unset `$env` tree-wide, so a shadowed declaration fails before step 1 rather than at step 14
  (ADR 0046).
- `src/run-workflow.ts` — A run-start config failure is reported as a failed run, not a load error:
  operator config is a run input (ADR 0022 sub-3), and the server's `POST /v0/runs` answers only after
  `run-started`, so a silent load failure would hang the request.

### `@path/schema`

- `src/node-walk.ts` — The controller-type membership table is a plain record tested with
  `Object.hasOwn`, not a `Set`: a plugin leaf type named `constructor` or `toString` must not be
  mistaken for a controller (ADR 0018).
- `src/node-walk.ts` — "Is this node a step?" is derived from the controller set, never from a fixed
  list of built-in step names: an allowlist silently skipped plugin step types in the reuse plan, the
  suppress set and legal-K alike (ADR 0021).
- `src/interpolation.ts` — The placeholder grammar is tokenized in exactly one place; the engine
  consumes tokens (including `unclosed`) and never scans for `}` itself. Two implementations once
  drifted into silently truncated values.
- `src/event-frame.ts` — The SSE frame decoder does not re-validate the event JSON; it trusts the
  `LogEventSchema` check the engine made before a backend wrote the line, and re-parsing could only
  reject a live stream mid-flight.
- `src/run-record.ts` — `reusedFromTreeRootId` is a read-time denormalization resolved during the
  archive/tree read, not a stored column, so a plain `getRun` returns null for it (ADR 0001).
- `src/wire-v0.ts` — `RootRunSummary` is written out by hand rather than derived from `RunRecord`, so
  a domain rename cannot silently rename a field of the published v0 API (ADR 0013 covers request
  bodies, not this).

### `@path/client-core`

- `src/blob-source.ts` — Context reads are never ref-gated: a run row has no `context_ref` column, so
  there is nothing to gate on and the 404 is the answer.
- `src/index.ts` — Every named package `exports` subpath is pinned by `test/subpath.test.ts`: tsc does
  not check an `exports` map, so an entry could point at a missing module and still typecheck.
- `src/launch-json.ts` — The client's launch gate is deliberately shallow (valid JSON, object shape);
  a fuller check would be a second, drifting copy of the wire contract, and the server's `400` is what
  the form surfaces (ADR 0012).
- `src/view-model.ts` — `RunNodeState` is the full domain `RunRecord`; a client-only subset would be a
  parallel definition with no consumer, since the wire carries every field.

### `@path/server`

- `src/confine.ts` — The read door requires every path component to exist, while the write door stops
  the symlink walk at the first missing component: a write may create the file and its parents, so
  there is no further symlink to follow, but a read folds a missing component into the same 404 as an
  escape (ADR 0016).
- `src/live-runs.ts` — In-flight runs are tracked as whole run promises, and `idle` drains that set
  before the project store closes: `start`/`resume` answer on `run-started`, so closing the
  better-sqlite3 store first makes a step's next `prepare` throw.
- `src/live-runs.ts` — A run's controller and live channel are torn down in one `.finally` on every
  outcome, with an idempotent channel close as the backstop for a `runWorkflow` rejection that emits
  no terminal event; otherwise SSE subscribers hang and controllers accumulate.
- `src/routes/cancel-run.ts` — The cancel route resolves the tree root with `RunTree.root` and never
  falls back to another row: a child row can read `succeeded` while the tree still runs, so a terminal
  status from it would refuse the cancel of a live run (ADR 0043).

### `@path/designer`

- `src/discovery.ts` — One shared `GET /v0/workflows` snapshot feeds the whole surface, and a failed
  scan keeps the last successful list: four per-consumer loads had three failure stances, and a
  transient blip must not empty every picker or flag every saved ref dangling.
- `src/edit-key.ts` — A typed `EditKey` is shared by the undo fold and the draft hooks; `owner` must
  be an id, not a constant, so switching frames re-seeds the draft. A colliding hand-minted string
  once folded two fields into one undo entry.
- `src/edit-target.ts` — One write door for the buffer (`replaceNode`/`withOptionalKey`/`withoutKey`)
  holds the optional-key policy: an empty field means no key, never `{}` or `""`.
- `src/edit-tree.ts` — Goto placement is enforced at the single edit door because no follow-up edit
  could repair a misplaced goto, and a rename retargets every goto naming the old name within the same
  edit so it is one undo step (ADR 0053).
- `src/interp-suggest.ts` — The canvas has no node-to-node wire: a step's input is one interpolable
  JSON value validated live in the pane, which is why this is a value editor and not a connection
  model (ADR 0029).
- `src/lease-client.ts` — The lease is per file and one session may hold several: a workflow-ref
  descent acquires a second marker under the same `session_id`, so the controller reconciles a set of
  paths rather than one lease (ADR 0017).
- `src/new-file-dialog.tsx` — Save-path confinement is server-side, symlinks included, and the
  dialog's stem cleaning only mirrors that guarantee rather than providing it (ADR 0016).
- `src/problems.ts` — The dangling-ref input type is `RefLookup`, deliberately not `…Context`:
  `Context` is a load-bearing glossary term (the run's inside-written state).
- `src/run/run-dock.tsx` — The dock's expanded/collapsed state is session-only by choice, unlike the
  height and column widths it persists.
- `src/session-reducer.ts` — The stale-fetch verdict lives in the reducer: a landing action is dropped
  because the frame no longer holds that `loadSeq`, not by a timing check in the hook.
- `src/validated-draft.ts` — `useDraft` re-seeds when the field's `identity` (`EditKey`) changes
  instead of relying on the caller to pass a React `key`, which a new call site could silently forget.

### `@path/viewer`

- `src/app.tsx` — Changing the runs-list status filter leaves the selected root run selected: the
  selection is a root run id resolved against the server, not a visible row, so narrowing the list
  must not stop watching a live run.
- `src/launch-form.tsx` — The launch form always parses the input and config-override fields from
  their own text, never gated on the disclosure being open, so a disclosure cannot silently drop a
  value the operator typed.
