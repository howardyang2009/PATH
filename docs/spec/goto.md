# `goto` — feature spec

**Status:** decisions locked (Wayfinder map [#544](https://github.com/howardyang2009/PATH/issues/544),
synthesis ticket [#602](https://github.com/howardyang2009/PATH/issues/602)). Plan-only: nothing here is
built yet. This spec is the implementation hand-off for `goto` (origin
[#478](https://github.com/howardyang2009/PATH/issues/478)).

This spec is **normative** for `goto`. It states each rule once, with every ADR amendment already
applied, so a build effort can implement from this document alone. The ADRs hold the rationale and the
rejected options. Where this spec and an ADR disagree, the ADR wins on *why* and this spec wins on
*what the code does*. The vocabulary follows [CONTEXT.md](../../CONTEXT.md): **Graph Controller**,
**first level**, **top-level walk**, **pass**.

| Topic | ADR | Ticket |
|---|---|---|
| Execution model | [0053](../adr/0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md) | #546, #550, #554 |
| Run identity per visit (passes) | [0054](../adr/0054-a-goto-visit-is-scoped-by-a-per-pass-container-run.md) | #548 |
| Target input seeding | [0055](../adr/0055-a-goto-target-is-seeded-by-the-gotos-passed-through-output.md) | #549 |
| Target by name, load checks | [0056](../adr/0056-a-goto-names-its-target-by-step-name-checked-at-load-in-path-schema.md) | #551 |
| Structure vs Graph Controller | [0057](../adr/0057-controllers-split-into-structure-and-graph-kinds.md) | #555 |
| Schema grammar, `@5` | [0058](../adr/0058-a-goto-is-target-plus-max-jumps-in-path-workflow-5.md) | #597 |
| Context under cycles | [0059](../adr/0059-context-under-goto-is-one-last-writer-wins-blackboard-across-passes.md) | #598 |
| Resume and Complete replay | [0060](../adr/0060-complete-follows-the-record-across-closed-passes-and-jump-counts-are-pass-rows.md) | #599 |
| Audit events | [0061](../adr/0061-goto-taken-and-goto-exhausted-are-walk-emitted-control-events.md) | #600 |
| Designer canvas | [designer-spec.md § `goto`](designer-spec.md) | #601 |

## 1. Scope and taxonomy

`goto` is the one **Graph Controller**. It sets the next node of a file's **top-level walk** to a named
**first-level node** of the same file, forward (a skip) or backward (a loop). The five **Structure
Controllers** (`parallel`, `sequence`, `branch`, `while-do`, `checkpoint`) are unchanged.

- A goto is a controller: no worker, no task, no run of its own (invariant 1).
- The file format stays a tree. A goto is an ordinary node in an ordinary slot, and its route is a
  `target` name property, not an edge. ADR 0029's rejection of a real DAG stands (ADR 0057 §4).
- Any future Graph Controller needs its own ADR (ADR 0057 §3).

Out of scope: `person-switch` (a Step-Template, ADR 0052), jumps into a nested body, jumps across files.

## 2. Grammar and load

### 2.1 The node

`path/workflow@5` adds a seventh reserved member:

```json
{ "type": "goto", "id": "<guid>", "name": "retry-jump", "target": "draft", "max_jumps": 3 }
```

- `.strict()`: no other key, and no step envelope (`config` / `input` / `parse` / `publish`).
- `target`: required. A `NameSchema` string (`^[a-z][a-z0-9-]*$`), the **name** of the target node,
  never its `id`.
- `max_jumps`: required. `MaxIterationsSchema` reused: a positive integer, or a string that
  interpolates to one over `STEP_ROOTS` (`config` + `context`). There is no parse-time default and no
  engine fallback. `3` is the authoring default only (the Designer pre-fills it).
- `goto` joins `buildCoreMembers` and `RESERVED_TYPE_NAMES`, so no plugin folder may claim the name.
- `goto` joins `ControllerType` / `CONTROLLER_TYPES` in `node-walk.ts`, so `isStepType("goto")` is
  false. `childBodies` / `mapChildBodies` return no child body for it.

### 2.2 Placement and target rules

- **Placement:** a goto may sit in any node slot whose ancestor chain holds no `while-do` and no
  `parallel`. That covers the first level, a first-level `branch`'s arm or `else`, and any
  `sequence` / `branch` nesting below one.
- **Target:** any other first-level node of the goto's own file: a step, a `workflow` step, a
  controller, or another goto. Never an inner node, and never the goto itself.
- **File-local:** "first level" is per file. A goto in a `workflow`-ref file targets and jumps within
  that file only.
- An unguarded first-level goto with a backward target is legal: another goto can jump past it.

### 2.3 Load refusals

A new `@path/schema` rule module returns issues as data, in the `publish-set.ts` pattern:
`{ rule, nodeId, path, message }`. `checkWorkflowFileInvariants` calls it. Every door that parses a
whole file gets it: the engine load, the server template store and the Designer's draft validation.
`makeBodySchema` does not call it, because a Step-Template body has no file namespace until it lands.

| `rule` | Case | Issue at | Message |
|---|---|---|---|
| `target-absent` | `target` names no node in the file | `target` | `goto target "retry" not found in this file` |
| `target-inner` | `target` names a node under `branch` / `sequence` / `while-do` / `parallel` | `target` | `goto target "check" is not a first-level node` |
| `target-self` | `target` names the goto itself | `target` | `goto "loop" targets itself` |
| `placement` | a goto under `while-do` or `parallel` | the goto node | `goto "x" may not sit under while-do "poll"` |

There is one issue per offender, and all issues come in one failed parse. There is no other refusal
case.

A Step-Template body may hold a goto. Its target is not checked in the template. After Instantiation,
the target file's check refuses an instance that breaks. Instantiation does not rewire targets.

### 2.4 Format bump

- `FORMAT_VERSION` moves to `path/workflow@5`. `SUPERSEDED_FORMAT_VERSIONS` gains `@4`, and
  `scripts/migrate-workflow-format-v5.ts` joins the `@0`–`@3` chains.
- The codemod is a no-op format stamp that refuses nothing. It discovers `*.workflow.json`,
  `*.step-template.json` and `*.workflow-template.json` under the repo root and `.path/template/`.
- An engine meeting a newer version reports `path/workflow@5 is newer than this engine reads
  (path/workflow@4) — upgrade PATH to read it`. A malformed version string still falls through to the
  literal mismatch.
- `docs/format/workflow-format-v5.md` (the delta) and the v4 superseded banner ship with the build.

## 3. Execution

### 3.1 The top-level walk

Each workflow-run's `runBody`, root or nested, walks its file's first level with a **top-level walk**:
an index loop with a jump register. Every nested body (`sequence`, branch arm, `while-do` iteration,
`parallel` branch) stays on `runSequence`, unchanged. The walk maps target `name` to GUID once per
workflow-run, from the parsed file.

### 3.2 The jump value

A goto node returns a new `SeqOutcome` variant:

```ts
{ status: "goto"; goto: string /* goto node GUID */; target: string /* target node GUID */; output: JsonValue }
```

`output` is the goto's incoming output, unchanged. Every nested walker already returns a
non-`succeeded` outcome early, so `runSequence`, `branch` and `sequence` pass it up unchanged. Only the
top-level walk consumes it. `runWorkflowNode` receives a `RunResult`, which has no `goto` variant, so a
child's jump never reaches its parent. The compiler finds every site that must handle the variant.

### 3.3 Passes

Only a file that contains a goto node has passes. This is decided at load, whether or not a jump is
taken. A goto-free file keeps today's tree exactly.

- A **pass** is one forward stretch of the top-level walk: from the start of the body, or from a jump
  target, up to the next jump taken or the end of the body. The walk always holds one open pass.
- Each pass is a container run. Every run made while it is open (first-level nodes and all nested
  runs) takes the pass as its parent. Within a pass each first-level node runs at most once, so
  `(scope, node id)` stays unique per pass.
- **Row:** run kind `pass`, a new nullable field `pass: number` (1-based, non-null only on a pass), read
  by one guard `isPassRun`. `nodeId` / `nodeName` name the goto that opened the pass, `null` for pass 1.
  A pass is worker-less and shares the workflow-run's context. `pass` is added once to
  `RUN_RECORD_FIELDS`, so the wire codec, the db row and `blankRunRecord` follow.
- **Status:** a pass closed by a jump or by the end of the body is `succeeded`. A pass in which a node
  fails, or in which a goto is exhausted, is `failed`, and the workflow-run fails with it. A pass holding
  a parked `person-activity` leaf stays `running`.
- **Disk:** no change. Every pass and every visit has its own run id.

Example: `[A, B, check]`, where `check` jumps back to `B` twice. Pass 1 = `A, B, check`; pass 2 =
`B, check`; pass 3 = `B, check`, then the end of the body.

### 3.4 Consuming a jump

When the top-level walk receives a `goto` outcome for goto `G`:

1. Count `G`'s jumps spent: the number of pass rows under this workflow-run whose `nodeId` is `G`.
2. If that count has reached `G`'s resolved `max_jumps`, emit `goto-exhausted` and fail the pass and
   the workflow-run, e.g. `goto "retry": max_jumps (3) exhausted`. There is no fall-through.
3. Otherwise emit `goto-taken`, close the open pass `succeeded`, open the next pass (its `nodeId` is
   `G`, its input is the outcome's `output`), emit `pass-started`, set the carried value to the
   outcome's `output`, and re-seek the index to the target.

A forward jump skips nodes, and a skipped node gets no run row.

## 4. Input seeding

- The goto's incoming output becomes the target's incoming output. The target resolves its input as
  any step does: its own `input` map when it declares one, otherwise that incoming output. A goto
  directly in a branch arm passes through the branch's incoming output.
- The same rule applies to both directions. A forward-jump target is never seeded from its skipped
  lexical predecessor.
- A revisit is a fresh run with its own recorded input. Nothing compares or reuses earlier visits.
- A pass container's `run-started` input is its seed: the workflow-run's input for pass 1, and the
  opening goto's passed-through output for pass N.
- No new interpolation root: no `${goto.*}` and no `${previous.*}`.

## 5. Context and publish

- All passes share the workflow-run's one blackboard, last-writer-wins. A jump neither snapshots, rolls
  back nor clears any key, the same as `while-do`.
- Reading a key that no node has published on the path taken fails the reading node with the existing
  `InterpolationError`. There is no load-time dataflow check and no default syntax. An author seeds a
  loop-carried key through the workflow's input or the launch `--context` seed.
- Each visit keeps its own per-step `context.json`. A pass container writes no snapshot.
- A first-level `parallel` that is a jump target joins like a first join on every visit. A `wait-one`
  join may pick a different winner per visit.
- The top-level walk threads the same `exec` context through every pass. There is no new context code.

## 6. Termination

- `max_jumps` is counted **per goto node, per workflow-run**. A re-run `workflow` step's fresh child run
  starts at zero.
- The authored guard is the enclosing branch arm's `when`. `max_jumps` is the backstop.
- There is no global cap. A `while-do` inside a jump loop keeps its own bound (worst case
  `max_jumps` × `max_iterations`).
- "Try N times, then continue" is written in the branch condition, not by falling through.

## 7. Audit

All three events are control events. `run_id` is the workflow-run, and `node_id` / `node_name` name
the goto. The top-level walk emits them.

| Event | Fires | Payload beyond the envelope | Client outcome |
|---|---|---|---|
| `pass-started` | a pass opens (pass 1 included) | `pass`; `node_id` / `node_name` are the opening goto, `null` for pass 1 | `null` |
| `goto-taken` | a jump is taken, forward or backward | `target_node_id`, `target_node_name`, `jump` (1-based, this one included), `max_jumps` (resolved), `pass` (the pass it opens) | `null` |
| `goto-exhausted` | a goto is reached with its jumps spent | `target_node_id`, `target_node_name`, `max_jumps`, `pass` (the pass that fails) | `failed` |

- No condition trace on any of them. The `branch-taken` before a guarded goto already carries it.
- Order, one jump: `goto-taken`, the closing pass's `step-finished` (succeeded), the new pass's
  `step-started`, `pass-started`, the target's `step-started`.
- Order, exhaustion: `goto-exhausted`, the pass's `step-finished` (failed), the workflow-run's
  `step-finished` (failed).
- The payloads hold ids, names and integers only, so the masker has nothing to scrub.
- The events are audit only. No engine state is read back from them.
- Event lines (`event-message`): `goto check jumped to B · jump 2/3 · pass 3`,
  `goto check exhausted · max_jumps 3 · target B`, and `pass 2 opened by goto check` (`pass 1` for
  the first).
- A field added to either goto event later needs a default, because every persisted log line is
  re-validated on read.

## 8. Resume and Complete

### 8.1 Resume

A Resume successor is a new run. It re-evaluates every condition fresh and may take another path.

- **Pass pairing:** when the successor opens pass N, it pairs with the predecessor's pass where
  `pass === N` **and** `nodeId` is the goto that just fired (`null` for pass 1), whatever that pass's
  status. It re-enters the pass with a `planReuse` scoped to it, so a failed pass reuses its succeeded
  nodes and re-runs from the failure. On a mismatch (no such pass, or a different opening goto), that
  pass and every later one run fresh.
- **Resume-from-K:** K may be a first-level node inside pass N, never an inner node of a first-level
  block. Passes 1 to N-1 reuse by pairing. Inside pass N, nodes before K reuse, and K and the rest of
  pass N re-run. Every later pass runs fresh. Legality keeps the prefix rule, counted across passes. The
  `rerunFromNodePath` entry for the level whose K sits in a pass gains an optional `pass: N`.
- **Jump counts** grow with the successor's own pass rows. A successor emits its own `goto-taken` for
  every jump its walk takes, including a jump into a paired, reused pass.
- **Seeding** needs nothing new: a reused pass's nodes replay their recorded outputs, so the goto that
  ends it passes through the same value.

### 8.2 Complete

Complete is the same run with one leaf finished. It follows the record and does not re-decide closed
jumps.

- A parked leaf always sits in the last pass, the one `running` pass. The replay reads the workflow-run's
  pass rows, takes the running pass N, and re-enters it in place by its ordinal. The Complete adapter's
  `findExistingChild` gains a `pass` scope beside `iteration`. Closed passes are not re-walked: no
  closed-pass condition is re-evaluated and no closed-pass goto fires again, and no event is emitted
  for them.
- **Start of the running pass:** index 0 for pass 1. For pass N, resolve the pass row's opening goto in
  the reloaded file and seek to its target. That target must be pass N's first recorded child (lowest
  `seq` under the pass). If the goto is gone or its target differs, the workflow-run fails:
  `Complete replay diverged: pass N was opened by goto "<G>" whose target is now "<X>", recorded "<Y>"`.
  The leaf's output is already committed, so a later Resume reuses it.
- Inside pass N the walk behaves as today: succeeded rows are read, the parked leaf is completed,
  conditions are evaluated fresh.
- Jump counts are the pass rows already present.
- This rule depends on Complete restoring context by load (its own `context.json`, ADR 0041). A future
  move of Complete to replay-from-seed must replay the closed passes' publishes in `seq` order.

## 9. Designer

The Designer contract is normative in [designer-spec.md § `goto`: a jump without an edge](designer-spec.md).
In summary:

- No edge. The goto block shows a `→ <target>` chip with `↑` (backward) or `↓` (forward). Selecting or
  hovering a goto highlights its target, and a targeted first-level node shows an incoming badge `← N`.
- The pane edits `name`, `target` (a dropdown of first-level nodes in file order, the goto itself
  excluded, a missing value shown as `missing: <name>`) and `max_jumps` beside `max_iterations`.
  `createNode` mints `{ type: "goto", …, target: "", max_jumps: 3 }`.
- Placement is unsnappable. The grammar check reads the socket's ancestor chain, so no palette add,
  move or template drop can put a goto under `while-do` or `parallel`.
- A rename rewrites every `target` naming the old name, in the same edit. A delete or move of the
  target rewrites nothing and yields a marker.
- Markers come from the §2.3 rule module, in the `publishSetIssues` pattern.
- The run projection skips pass rows, so a goto takes no status tint. A watched run shows jumps spent,
  `<spent>/<max_jumps>`.

## 10. Viewer and CLI

- The run tree gains one level under a workflow-run whose file holds a goto. `run-tree.tsx` labels a
  pass `Pass N`, with `· opened by <goto name>` for N > 1, beside the existing iteration label.
- `path runs`, the read-time cost SUM (`subtree`, `findRootRun`) and the Designer's inspector read the
  same tree and need no special case.
- The run tree shows a jump only as a pass row. There is no drawn edge.

## 11. Test matrix

IDs are `G-<package>-<nn>`, where the package is `S` (schema), `E` (engine), `D` (designer), `V`
(viewer / client-core). Build tickets cite these IDs.

### Schema

| ID | Setup | Expected |
|---|---|---|
| G-S-01 | `@5` file with a first-level backward goto and a guarded goto in a branch arm | loads |
| G-S-02 | `target` names no node | one `target-absent` issue at `target` |
| G-S-03 | `target` names a node inside a first-level `sequence` | one `target-inner` issue at `target` |
| G-S-04 | a first-level goto targets itself | one `target-self` issue at `target` |
| G-S-05 | a goto under `while-do`; another under `parallel` (via `sequence` / `branch` nesting) | one `placement` issue each, at the goto node, in one failed parse |
| G-S-06 | target is a first-level `branch`, `while-do`, `parallel`, `checkpoint` and another goto | loads |
| G-S-07 | goto with `max_jumps` omitted; with `0`; with `"${config.n}"` | refused; refused; loads |
| G-S-08 | a plugin folder named `goto` | refused as a reserved name |
| G-S-09 | `@5` file on a `@4` engine | the "newer than this engine reads" message |
| G-S-10 | codemod over a goto-free `@4` file and a `@4` template | byte-identical except `format` |
| G-S-11 | Step-Template body holding a goto with a dangling target | template stores; the instance fails the target file's check |

### Engine

| ID | Setup | Expected |
|---|---|---|
| G-E-01 | goto-free file | run tree identical to today, no pass rows, no `pass-started` |
| G-E-02 | file with a guarded goto whose condition is never true | pass 1 only, `succeeded`; one `pass-started`, no `goto-taken` |
| G-E-03 | forward jump `[A, check→C, B, C]` | `B` has no row; `C`'s input is the goto's passed-through output; `goto-taken` with `jump 1` |
| G-E-04 | backward jump `[A, B, check→B]`, condition true twice | passes 1–3 as in §3.3; each `B` visit its own run with its own input; pass rows' `nodeId` = the goto |
| G-E-05 | backward loop whose condition stays true, `max_jumps: 2` | 2 `goto-taken`, then `goto-exhausted`; pass 3 and the workflow-run `failed` with the exhausted message |
| G-E-06 | event order for G-E-04 and G-E-05 | exactly the §7 order by `seq` |
| G-E-07 | goto inside a nested `workflow`-ref file | the child's own passes and counts; the parent sees one ordinary `workflow` step run |
| G-E-08 | the same `workflow` step visited twice by a parent loop, child holding a goto | each child run counts from zero |
| G-E-09 | backward loop where the target reads `${context.verdict}` published after it | pass 2 reads pass 1's value; pass 1 fails with `InterpolationError` unless seeded |
| G-E-10 | a first-level `wait-one` `parallel` as a jump target | joins on each visit; winner may differ per visit |
| G-E-11 | `max_jumps: "${config.n}"` | resolved value is the bound and appears in `goto-taken` |
| G-E-12 | Complete: `person-activity` parked in pass 2 of a loop | Complete re-enters pass 2 in place; no second pass 2; no event for pass 1; the run continues and may jump again |
| G-E-13 | Complete after the opening goto's target was edited in the file | fails with the `Complete replay diverged` message |
| G-E-14 | Resume of a run that failed in pass 3, file unchanged | passes 1–2 pair and reuse; pass 3 re-enters, reuses its succeeded nodes, re-runs from the failure |
| G-E-15 | Resume after an edit makes a different goto open pass 2 | pass 2 and later run fresh |
| G-E-16 | Resume-from-K with K in pass 2 | pass 1 reuses; nodes before K in pass 2 reuse; K and the rest re-run; later passes fresh |
| G-E-17 | Resume-from-K into pass 1 of a loop that publishes in later passes | K sees its original context — **pending #608** |
| G-E-18 | Resume successor jumps into a paired pass | successor log has its own `goto-taken` and `pass-started` |
| G-E-19 | Cancel while a pass holds a running leaf | pass and workflow-run `cancelled` as today; no goto event |

### Designer

| ID | Setup | Expected |
|---|---|---|
| G-D-01 | palette over a socket inside `while-do` / `parallel` (any depth) | `goto` not offered |
| G-D-02 | move a `sequence` holding a goto into a `while-do` | refused |
| G-D-03 | Step-Template drop holding a goto into a `parallel` branch | refused |
| G-D-04 | rename the target | every `target` naming it is rewritten; one undo step restores both |
| G-D-05 | delete the target; move it into a `sequence` | not refused; `target-absent` / `target-inner` marker on the goto |
| G-D-06 | target picker | first-level nodes in file order, self excluded, forward/backward marked; `missing: <name>` for a bad value |
| G-D-07 | chip, highlight, incoming badge `← N` | as designer-spec § `goto` |
| G-D-08 | watched run with passes | goto block untinted; jumps-spent badge; a revisited node shows its latest run |

### Viewer and client-core

| ID | Setup | Expected |
|---|---|---|
| G-V-01 | run tree of G-E-04 | `Pass 1`, `Pass 2 · opened by check`, `Pass 3 · opened by check` |
| G-V-02 | event lines for `pass-started`, `goto-taken`, `goto-exhausted` | the §7 texts; `goto-exhausted` routes to `failed` |
| G-V-03 | an old `run.log` with none of the new events | still parses |

## 12. Build hand-off

Five slices, in order. Each slice lands green on its own matrix rows.

1. **Schema and format** — `nodes.ts`, `node-type.ts` (`GotoNode`), `node-walk.ts`, the new goto rule
   module, `workflow-file.ts`, `workflow-file-type.ts` (`@5`, symmetric version message),
   `scripts/migrate-workflow-format-v5.ts`, `docs/format/workflow-format-v5.md`, the "seven reserved
   names / six controllers" wording, and the `@5` stamp in `CONTEXT.md`. Rows G-S-*.
2. **Engine walk, passes, seeding, events** — `run-workflow.ts` (top-level walk in `runBody`, the
   `goto` `SeqOutcome`), `run-kind.ts` / `run-record.ts` (`pass`, `isPassRun`), `log-event.ts`,
   `run-observer.ts`, `run-emitter.ts`, `logging-observer.ts`, `persisted-observer.ts`,
   `secret-mask.ts`. Rows G-E-01 to G-E-11, G-E-19.
3. **Resume and Complete** — `plan-reuse.ts` (pass-scoped reuse), `continuation.ts`
   (`findExistingChild` `pass` scope, running-pass seek and divergence check), `resume-legal-k.ts` and
   `descend-node-path.ts` (K in pass N, `rerunFromNodePath` `pass`). Rows G-E-12 to G-E-18.
4. **Designer** — `grammar.ts` (ancestor-aware socket check), `palette-data.ts`, `node-factory.ts`,
   `properties-pane.tsx`, `edit-tree.ts` (rename rewrite), `problems.ts`, `canvas.tsx` /
   `block-tree.tsx` (chip, highlight, badge), `run/run-projection.tsx`. Rows G-D-*.
5. **Viewer and client-core** — `run-tree.tsx` pass label, `event-message.ts`, `event-outcome.ts`. Rows
   G-V-*.

Slices 4 and 5 depend on slice 1 (and slice 5 on slice 2 for the event types) but not on each other.

## 13. Open dependencies

- **#608** (Resume replays context from the seed, not the final `context.json`): until it lands,
  Resume-from-K into an earlier pass sees keys that later passes wrote. The same gap exists without
  goto, and goto adds no rule of its own (ADR 0059 §5). The build does not wait for it. G-E-17 stays
  pending until #608 lands.
