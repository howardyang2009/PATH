# Resume-from-K eligibility listing (`path run … --resume … --list-eligible`)

This spec is the CLI listing that lets an operator find a legal `--from <run-id>` value before they
resume ([#441](https://github.com/howardyang2009/PATH/issues/441), part of map
[#427](https://github.com/howardyang2009/PATH/issues/427)). It is a dependency of the `--from` flag
itself ([#431](https://github.com/howardyang2009/PATH/issues/431)) and shares that flag's resume form.
The boundary semantics it renders live in `CONTEXT.md` §Resume (**Rerun boundary (K)**), and the
refusal taxonomy it names is [ADR 0032](../adr/0032-resume-from-k-boundary-representation-and-successor-provenance.md).
The command shape is [ADR 0034](../adr/0034-resume-eligibility-listing-rides-resume-not-runs-show.md).

## 1. The problem

Resume-from-K names K by the **source node's run id** (ADR 0032): `--from <run-id>`. But `path runs`
lists **root runs only** — one row per root ([cli.ts](../../packages/engine/src/cli.ts) `runRunsListCommand`).
No CLI surface prints a tree's per-node run ids, so an operator working from the CLI has no way to see
the run id of a node inside a source tree, nor which nodes are a legal K. This listing closes that gap:
one row per node in the source tree, with an **`eligible?`** column that applies the legal-K test and,
when a node fails it, names the reason.

## 2. Command

```
path run <workflow.json> --resume <root-run-id> --list-eligible
```

`--list-eligible` is a **dry-run of resume**. It computes and prints the per-node eligibility of the
source tree named by `--resume <root-run-id>`, evaluated against `<workflow.json>`, and **launches
nothing** — no successor run, no store write.

- `--list-eligible` **requires** `--resume <root-run-id>` (it needs a source tree). Without `--resume`
  it is a usage error.
- `--list-eligible` is **mutually exclusive** with `--from <run-id>`: one lists candidates, the other
  resumes from a chosen one. Both together is a usage error.
- Launch-time flags that only a real launch consumes (`--config`/`--set`, `--context`/`--set-context`)
  are refused in list mode; it launches nothing to apply them to.
- `-C <dir>` is inherited from `path run` unchanged — store-only, it may appear anywhere in the args
  ([ADR 0005](../adr/0005-path-run-dash-c-is-store-only.md)). The `<workflow.json>` positional still
  resolves against the real working directory, never re-rooted under `<dir>`.

The file lives on `path run`, not on the file-free `path runs` family; ADR 0034 records why.

## 3. Eligibility is file-aware, from one authority

The `eligible?` verdict is **not** computed from the store's run rows alone. Logicers (parallel,
branch, while-do, sequence) leave **no run row** (invariant 1), so the run tree keyed on `parentRunId`
cannot tell a top-level node from one nested inside a loop / parallel / branch body — both carry the
enclosing workflow-run as their parent run. The legal-K test therefore needs the workflow **structure**,
supplied by `<workflow.json>`.

The listing runs the **same legal-K predicate** that `Project.resume` runs to validate a single
`--from` selection before a successor starts (ADR 0032, §Consequences "one authority resolves and
validates"). Both take the same two inputs — the source tree's rows (`getRunsForRoot`) and the current
`rootFile` — and apply the same rule from `CONTEXT.md` §Resume:

> A **legal K** resolves to a node still present in the current file, **succeeded**, at the **top
> level** of its own level's body, whose whole prefix `<K` also succeeded.

Applying the one predicate per row (listing) and to one selection (resume validation) is what
guarantees the column can never say **eligible** where `--from` would refuse, or the reverse. The
predicate is a single shared function; `--list-eligible` and the resume path must not carry two copies.

## 4. Rows shown

**Every run row in the source tree**, in **tree pre-order (depth-first)** so a node sits under its
parent and the tree structure reads top-down. No row is silently hidden — a reader sees each node and,
where it is not a legal K, why. Specifically:

- The **root row** is shown, always with the fixed reason `root run (never a boundary)`.
- **Reuse rows** (a chained resume's reused nodes, #257) are shown and are eligible K when they pass the
  test, matching the Designer's affordance ([ADR 0033](../adr/0033-designer-resume-from-k-is-a-selection-driven-run-action-button.md)).
- **In-body nodes** (a step inside a loop / parallel / branch body) are shown with their locus reason;
  they are never a legal K (map #427 out of scope), but the operator sees them and learns why.

A root run always has at least its own root row, so the listing is never empty.

## 5. Columns and format

Four columns, rendered in the space-aligned table style of `path runs`
([cli.ts](../../packages/engine/src/cli.ts) `formatRunsTable`): a header line, every column but the last
padded to its widest cell.

| column      | content                                                                        |
|-------------|--------------------------------------------------------------------------------|
| `run-id`    | the node's run id, **never truncated** — the operator copies it into `--from`  |
| `node-name` | the node's human `node_name` (ADR 0007); `-` when a row records none            |
| `status`    | the run's status (`succeeded`, `failed`, `cancelled`, `running`, …)             |
| `eligible?` | `yes` when a legal K; otherwise the one reason from §6                          |

There is **no `--json`** mode. Machine consumers read the descent path and per-node facts from the #418
read wire (`rerun_from_node_path` on the RunRow), not from a second JSON surface here.

## 6. The `eligible?` reason vocabulary

When a node is a legal K, the cell is `yes` (no reason). Otherwise the cell holds exactly one reason,
mapping 1:1 to the ADR-0032 five-reason taxonomy, minus reason #1 (**run id in no run of the source
tree**), which can never fire here — every listed row is a run of the tree being listed:

| reason cell                                | ADR-0032 taxonomy | meaning                                                              |
|--------------------------------------------|-------------------|----------------------------------------------------------------------|
| `not in current file`                      | #2 (409)          | the node's id resolves to no node in `<workflow.json>` (since-deleted)|
| `inside a <loop\|parallel\|branch> body`   | #3 (400)          | illegal locus; the container is named                                |
| `not succeeded`                            | #4 (409)          | the node's own run did not reach `succeeded`                         |
| `prefix not all succeeded`                 | #5 (409)          | a top-level node before K at K's level did not succeed               |
| `root run (never a boundary)`              | —                 | the root row; the implicit root step is never a K                    |

The container name in the locus reason is the innermost enclosing logicer (`loop` for while-do,
`parallel`, or `branch`).

## 7. Whole-command gates and exit codes

The precondition and error handling mirror a real resume, so the listing and the resume it feeds refuse
the same inputs the same way.

| situation                                                         | exit |
|-------------------------------------------------------------------|------|
| listing printed                                                   | `0`  |
| `--resume <root-run-id>` names no run in the store                | `1`  |
| source root run **not terminal** (still running)                  | `1`  |
| `<workflow.json>` missing / invalid / names an unregistered plugin| inherited from `path run` |
| bad flags, `--from` + `--list-eligible`, or `--resume` absent     | `2`  |

- **Not terminal.** The legal-K taxonomy assumes a terminal source tree (a node's status can still
  flip while the tree runs; map #427 precondition). If the root run is not terminal, the whole command
  is refused with the same message a real resume gives — it is not a per-row verdict.
- **Not found.** A `--resume` id that names no root run (or a non-root/child id) is refused with
  `no run found with root run id "<id>"`, matching `Project.resume`'s own `found: false`
  ([project.ts](../../packages/engine/src/project.ts)).
- **File load.** File-not-found, schema-invalid, and unregistered-step-type errors are `path run`'s
  existing load errors, unchanged (registry-relative validity; `CONTEXT.md` §Step-type plugins).

## 8. Out of scope

- The `--from` flag itself and its resume behavior ([#431](https://github.com/howardyang2009/PATH/issues/431)).
- Any change to the resume wire, the boundary representation, or the refusal taxonomy
  (ADR 0032 / [#429](https://github.com/howardyang2009/PATH/issues/429)). This listing only **renders**
  the existing legal-K verdict; it defines no new domain term, so `CONTEXT.md` is unchanged.
- K inside a loop or parallel body (per-iteration identity; retired #420/#426). Such nodes list with
  the locus reason and are never eligible.
- Telemetry of who moved K and to where (map #427 "not yet specified").
