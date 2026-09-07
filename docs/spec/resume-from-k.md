# Resume-from-chosen-K Specification

This spec resolves wayfinder ticket [#432](https://github.com/howardyang2009/PATH/issues/432). It is the
destination artifact of [map #427](https://github.com/howardyang2009/PATH/issues/427). It assembles every
closed decision of the map into one buildable spec for **Resume-from-chosen-K**: a Resume variant where
the operator moves the reuse/rerun boundary **K** earlier than today's auto-boundary. Nodes before K
reuse their succeeded results (reuse rows, direct-to-source); K and every serialized-later node re-run in
a fresh non-destructive successor tree. Plain Resume becomes the `K = auto-boundary` case of the same
action.

**How to read this document.** The vocabulary follows [CONTEXT.md](../../CONTEXT.md) §Resume exactly; the
terms there are canonical. Several decisions already have normative documents in this repo, and this spec
*incorporates them by reference* rather than restate them: the boundary representation and provenance
([ADR 0032](../adr/0032-resume-from-k-boundary-representation-and-successor-provenance.md)), the two
engine-mechanism ADRs ([0035](../adr/0035-resume-rerun-boundary-is-a-suppression-set-on-the-two-reuse-producers.md),
[0036](../adr/0036-resume-rerun-boundary-is-a-per-level-plan-reuse-override.md)), the Designer surface
([ADR 0033](../adr/0033-designer-resume-from-k-is-a-selection-driven-run-action-button.md),
[designer-spec.md § Resume from here](designer-spec.md)), and the CLI eligibility listing
([ADR 0034](../adr/0034-resume-eligibility-listing-rides-resume-not-runs-show.md),
[resume-eligibility-listing.md](resume-eligibility-listing.md)). The two engine-mechanism research docs
([resume-from-k-mechanism.md](../research/resume-from-k-mechanism.md),
[resume-from-nested-k-mechanism.md](../research/resume-from-nested-k-mechanism.md)) carry the `file:line`
mechanism map the ADRs decide over. Where this document and a tracker comment disagree, this document
wins. §10 maps every section back to its originating ticket and ADR.

---

## 1. Scope

**In Resume-from-chosen-K:**

- A Resume in which the operator names a rerun boundary **K** earlier than the auto-boundary, so a
  **succeeded** region re-runs against changed config or a changed downstream, while the succeeded prefix
  is reused rather than recomputed.
- One action, two triggers: **plain Resume** omits K (auto-boundary); **Resume-from-K** supplies it. One
  wire field, one engine path, one form. Plain Resume is the `K = auto-boundary` case, not a second code
  path (§3, §4).
- K may be a top-level node of the root file **or** a node inside a nested `workflow` file, reached by a
  descent path (§4, ADR 0036).
- Three surfaces that name or list K: the Designer `Resume from …` button (§7.1), the CLI `--from`
  resume flag (§7.2), and the CLI `--list-eligible` listing (§7.3).
- A non-destructive successor: the source run stays read-only and re-runnable, nothing is deleted (§6,
  ADR 0001).

**Out of scope** (§8): K inside a loop / parallel / branch body (per-iteration identity, retired
#420/#426); telemetry of who moved K and where; a new `path resume` verb; a `--json` listing mode; any
back-compat migration of pre-existing run records.

## 2. The boundary in brief

The canonical definitions are `CONTEXT.md` §Resume (**Rerun boundary (K)**, **Reuse row**,
**Reuse-marker**, **Successor run**). In brief, for a builder:

- **K** is the node a Resume re-runs *from*. Nodes serialized **before** K reuse their succeeded results;
  K and every serialized-**later** top-level node re-run entire in the successor.
- When K sits inside a nested `workflow` file, the boundary is a **descent path** root→…→K. At **each**
  level on the path the level's **path-node B** (the path element at that depth) splits the level's
  top-level body into three **dispositions**: **reuse** (before B), **rerun-entire** (after B, and B
  itself when B == K), and **descend** (B when it is an intermediate `workflow` node — re-entered with
  partial reuse under the next level's boundary). Intermediate path-nodes are `workflow` nodes by
  necessity; only K may be a leaf.
- **Plain Resume is K at the auto-boundary** (the first non-succeeded top-level node), so Resume-from-K is
  a **strict superset** of plain Resume, which is itself a strict superset of the length-1 (top-level K)
  case. One action, one code path (§4, ADR 0035/0036).
- The operator selects K by the **source node's run id** — the one unambiguous handle. A bare node id is
  file-scoped and cannot tell two refs of one nested file, or two loop iterations, apart (§3, ADR 0032).

## 3. Wire representation

Normative source: [ADR 0032](../adr/0032-resume-from-k-boundary-representation-and-successor-provenance.md).

- **The wire names K by the source run id.** One scalar field `rerun_from_run_id` on the existing
  `POST /v0/runs/:root_run_id/resume` body (`packages/server/src/routes/resume-run.ts`), and `--from
  <run-id>` on the existing resume form at the CLI (§7.2). Absent field / flag = plain Resume.
- **The engine resolves the run id to a node-id descent path.** `Project.resume`
  (`packages/engine/src/project.ts`) walks the source run's `parentRunId` to root to build
  `ResumeInput.rerunFromNodePath` (§4). The client stays dumb: run-id→path resolution and legal-K live at
  the one authority in the engine, never in a surface.
- **The node-id path is the identity matched against the current file.** A rename or move of a node
  survives (matched by id); a delete fails (§5). The run-id selection is checked before the successor
  starts.

## 4. Engine mechanism

Normative sources: [ADR 0035](../adr/0035-resume-rerun-boundary-is-a-suppression-set-on-the-two-reuse-producers.md)
(the root-only base), [ADR 0036](../adr/0036-resume-rerun-boundary-is-a-per-level-plan-reuse-override.md)
(the per-level generalization). The `file:line` map is
[resume-from-k-mechanism.md](../research/resume-from-k-mechanism.md) and
[resume-from-nested-k-mechanism.md](../research/resume-from-nested-k-mechanism.md).

The builder implements the per-level form (ADR 0036); the root-only form (ADR 0035) is its length-1 special
case, not a separate build.

**The boundary threads two engine types:**

```ts
// run-workflow.ts — set once by Project.resume from rerunFromNodePath.
export interface ResumeInput {
  originalRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  /** Descent path of node ids root→…→K. [] / undefined = plain Resume. Length 1 = top-level K. */
  rerunFromNodePath?: string[];
}

// run-context.ts — the remaining path from this level down; head = this level's path-node B.
export interface RunResume {
  input: ResumeInput;
  counterpart: RunRecord | undefined;
  plan: ReusePlan;
  /** [] = off-path / plain Resume. */
  rerunSuffix: string[];
}
```

- **The suffix is seeded and threaded structurally.** The root run seeds `rerunSuffix =
  rerunFromNodePath ?? []`. Each descent into the path-node passes `suffix.slice(1)`; every off-path
  sibling passes `[]`. On-path-ness is structural — only the node whose id equals the suffix head receives
  a tail — so ids stay file-scoped by construction (ADR 0036).
- **Each on-path level derives two sets** from its own body `B[]` and suffix head `head = S[0]`, `i =
  B.findIndex(n => n.id === head)`, `isLeaf = S.length === 1`, over the run-producing ids of `B.slice(i)`
  (the exact `walkNodes`/`RUN_PRODUCING_TYPES` walk `planReuse` already uses):
  - `suppress` — B and everything after it (Producer A).
  - `rerunEntire` — after B only; equals `suppress` minus B when B descends (Producer B).
  - They differ by **exactly B, only when B is intermediate**. That one-element gap is the **descend**
    disposition.
- **The two producers each get one guard, applied at every on-path level:**
  - **Producer A — `planReuse`** (`plan-reuse.ts`): take an optional `suppress` set; `if
    (suppress?.has(node.id)) continue` in the walk, so B and after-B never plan reuse. Passed at every
    on-path level (contrast ADR 0035's root-only pass), keyed off this run's own `rerunSuffix`.
  - **Producer B — the descent site** (`run-workflow.ts`): for a B-or-after-B `workflow` node, choose
    **descend** (intermediate B: re-enter the counterpart, hand it `S.slice(1)`), **rerun-entire**
    (after B, or B == K: counterpart `undefined`, child seeds fresh, whole subtree re-runs), or
    **reuse/off-path** (before B: already short-circuited in the plan; any other off-path child re-enters
    with `[]`, as plain Resume).
- **No new node walker, no second code path.** The prefix at every level reuses bit-for-bit as today.
  Cascade-up (nodes after the containing `workflow` node re-run at every ancestor level) is the after-B
  rule applied per level, not a dataflow pass.

**Superset invariant (the builder's regression anchor):** empty path ≡ plain Resume byte-for-byte;
length-1 top-level path ≡ ADR 0035; K at the auto-boundary ≡ plain Resume. Nested-K ⊇ ADR 0035 ⊇ plain
Resume, all one path.

**Prefix loops / parallel are unchanged.** A prefix id is never in `suppress`, and the walkers read reuse
only through `plan.get(node.id)` and the wait-one winner picker, so a prefix loop reuses (or refuses to
reuse a >1-iteration loop under the existing uniqueness guard) identically to today. The
multi-iteration-loop reuse limit is neither fixed nor worsened.

## 5. Precondition, legal K, and the refusal taxonomy

Normative source: [ADR 0032](../adr/0032-resume-from-k-boundary-representation-and-successor-provenance.md)
§Consequences.

- **Precondition.** The source root run is **terminal**. A node's status can still flip while the tree
  runs, so the legal-K test assumes a terminal source tree. A non-terminal source is refused whole, with
  the message and exit code a real resume gives; it is never a per-row verdict (§7.3).
- **Legal K** (the one predicate, run at one authority): K resolves to a node **still present** in the
  current file, **succeeded**, at the **top level** of its own level's body, whose whole **prefix `<K`**
  at that level also succeeded. Plain Resume omits the selection entirely.
- **`Project.resume` is the one authority.** It holds both halves the check needs — the source tree rows
  (`getRunsForRoot`) and the current `rootFile` — resolves the run id, matches the node-id path against
  the current file, enforces legal-K, and returns a structured `refusal: {status, message}`. The route
  has one exit for every engine-side refusal and no hardcoded status. The engine's per-level `i < 0` throw
  is a backstop only, never reached after validation.
- **The refusal taxonomy** (checked only when `rerun_from_run_id` is present, first failure wins):

  | # | reason | status |
  |---|--------------------------------------------------|-----|
  | 1 | run id in no run of the source tree              | 400 |
  | 2 | resolves to a since-deleted node                 | 409 |
  | 3 | illegal locus (inside a loop/parallel/branch body) | 400 |
  | 4 | K node not succeeded                             | 409 |
  | 5 | prefix `<K` not fully succeeded                  | 409 |

  400 = unresolvable or unsupported selection; 409 = state or file-divergence conflict. The surfaces
  render this one taxonomy: the Designer disabled-reason (§7.1) and the listing `eligible?` reason
  vocabulary (§7.3) are 1:1 with it (the listing drops reason #1, which can never fire on a row of the
  tree being listed).

## 6. Successor provenance and persistence

Normative source: [ADR 0032](../adr/0032-resume-from-k-boundary-representation-and-successor-provenance.md).

- **Two provenance facts stay separate columns.** `resumed_from_root_run_id` answers *which run the
  operator resumed* (tree-level, always the immediate predecessor, ADR 0001); a new root-only column
  `rerun_from_node_path` (JSON `{nodeId, nodeName}[]`, null on plain Resume) answers *where inside it K
  sat*. Never one overloaded field.
- **The persisted path is a read denormalization.** Correctness never reads it: it is re-derivable from
  the successor's own rows (at each level, the first child with a genuine-execution row, not a reuse row).
  It exists so the #418 descent crumbs read K per crumb from one clean source. It is exposed on the read
  wire (`packages/schema/src/wire-v0.ts` RunRow → `packages/client-core/src/view-model.ts`
  `rerunFromNodePath`).
- **Schema bump-and-break, no migration.** `SCHEMA_VERSION` goes 7 → 8, adding `rerun_from_node_path
  TEXT` to the `runs` table. A pre-#429 db refuses to open with the standard message rather than silently
  lacking the column — the seventh such bump, identical policy to #19/#169/#204/#202/#257/#332. No
  backfill; there is no mixed-version world to reconcile. This is the whole of the "back-compat of
  persisted run records" answer.
- **Rows are ordinary.** ≥K nodes write fresh `succeeded` rows; <K nodes write reuse rows (#257) exactly
  as plain Resume. `RunRecord` needs no boundary field.

## 7. Surfaces

### 7.1 Designer — the `Resume from …` button

Normative source: [designer-spec.md § Resume from here](designer-spec.md),
[ADR 0033](../adr/0033-designer-resume-from-k-is-a-selection-driven-run-action-button.md). In brief:

- A **third run-action button**, `Resume from …`, beside `Resume run` and `Delete run` in the run detail's
  left action column. It is the K-supplied case of the one Resume action; `Resume run` is the K-omitted
  auto-boundary case. Same config-only form, same engine route.
- **K is the run of the node selected in the middle run tree** — the only handle carrying a run id. The
  canvas node maps to many runs and carries none, so the canvas never hosts this action.
- **Always rendered, two states.** Enabled label `Resume from <node-name> (<short-run-id>)` (full run id
  on wire and hover); or disabled with **one** reason, in precedence: (1) no node selected, (2) illegal K
  (the matching entry of the §5 taxonomy), (3) legal K but a dirty buffer (Launch's save-first "Save to
  enable").
- **Legal K computed client-side, refused server-side.** The client greys illegal rows eagerly from the
  run tree it holds; the engine `refusal` (§5) is the backstop for a race where the on-disk file moved.
- **Clean-buffer gated, no lease.** Resume-from-K matches K's node path against the bytes on disk, so it
  gates on the same one save-point Launch does (ADR 0030) and takes no edit-lock lease (ADR 0017) — it
  reads the file only.
- **Nested nodes and reuse rows are selectable K; the root row is never K.** A `succeeded` root run shows
  no `Resume run`, so `Resume from …` is its only resume path.

### 7.2 CLI — the `--from <run-id>` resume flag

Normative source: issue [#431](https://github.com/howardyang2009/PATH/issues/431). In brief:

- The resume-form flag that names K rides the existing form, **not** a new `path resume` verb: `path run
  <workflow.json> --resume <root-run-id> --from <run-id>`.
- **The CLI does zero K-logic.** It parses and forwards the run id only; all run-id→path resolution and
  legal-K stay in `Project.resume` (§5, ADR 0032). The CLI prints `refusal.message` **verbatim** — one
  wording authority, no drift across route / CLI / listing.
- **Exit codes:** `0` printed; `1` every engine refusal (400/404/409 collapse — the command parsed, the
  engine refused); `2` parse-time only (`--from` without `--resume`, bad flags, `--from` + `--list-eligible`).
- **No `--input` flag exists**; the `--context`/`--set-context` seed is already blocked with `--resume`,
  so the config-only form is free. The `--from` + `--list-eligible` exclusion is owned by whichever of
  §7.2/§7.3 lands second in the build.

### 7.3 CLI — the `--list-eligible` eligibility listing

Normative source: [resume-eligibility-listing.md](resume-eligibility-listing.md),
[ADR 0034](../adr/0034-resume-eligibility-listing-rides-resume-not-runs-show.md). In brief:

- `path run <workflow.json> --resume <root-run-id> --list-eligible` — a **dry-run of resume** that prints
  one row per node in the source tree so an operator can find a legal `--from` value. Launches nothing.
- It rides the resume form, **not** a `path runs show` subcommand: a truthful `eligible?` column needs the
  workflow file, and files live on `path run`, never on the file-free `path runs` family (ADR 0034).
- **One authority.** The `eligible?` verdict runs the **same** legal-K predicate `Project.resume`
  validates a single `--from` against (§5), over the same two inputs (source rows + current file), so the
  column can never disagree with `--from`.
- **Every row shown, tree pre-order (DFS):** root marked `root run (never a boundary)`, reuse rows
  eligible when they pass, in-body nodes with their locus reason. Four columns (`run-id` never truncated,
  `node-name`, `status`, `eligible?`). No `--json` (machine consumers read `rerun_from_node_path` off the
  #418 read wire). The `eligible?` reason vocabulary is 1:1 with the §5 taxonomy minus reason #1.
- **Whole-command gates** mirror a real resume: non-terminal source or unknown root refuses whole (exit
  `1`); file-load errors inherited from `path run`; bad flags / `--resume` absent / `--from` +
  `--list-eligible` are exit `2`.

## 8. Out of scope

- **K inside a loop / parallel / branch body.** Per-iteration loop identity is the retired #420/#426
  problem; loops inherit today's Resume behavior (prefix loops re-run). Such nodes list with the locus
  reason (§7.3) and are never a legal K. Redraw only as a fresh effort.
- **Telemetry / audit** of who moved K and to where (map #427 "not yet specified"; revisit after the
  surface tickets).
- **Step-by-step debug stepping** (retired debug map #419, closed).
- **A `path resume` verb, a `--json` listing mode, and any pre-existing-record migration.** The wire is
  one field on the existing form; the schema is a bump-and-break clean slate (§6).

## 9. Acceptance criteria

A builder has delivered Resume-from-chosen-K when:

1. `POST /v0/runs/:root_run_id/resume` accepts optional `rerun_from_run_id`; `Project.resume` resolves it
   to a node-id descent path, enforces the §5 legal-K predicate at one authority, and returns
   `refusal: {status, message}` with the §5 taxonomy (§3, §5).
2. The engine threads `ResumeInput.rerunFromNodePath` and per-level `RunResume.rerunSuffix`, guards both
   reuse producers per on-path level, and realizes the three dispositions (§4). The superset invariant
   holds: empty path ≡ plain Resume byte-for-byte; length-1 ≡ top-level K; K = auto-boundary ≡ plain
   Resume.
3. The successor persists `rerun_from_node_path` beside `resumed_from_root_run_id`; `SCHEMA_VERSION` is 8;
   the field is on the read wire; correctness never reads it (§6).
4. The Designer renders the always-shown `Resume from …` button with the two states and the reason
   precedence (§7.1); the CLI carries `--from` with the exit-code table and verbatim refusal message
   (§7.2); the CLI carries `--list-eligible` with the four-column listing and the shared predicate (§7.3).
5. Nested-K (K inside a nested `workflow`) re-runs from K with partial reuse of the inner prefix; reuse-row
   K and nested-workflow-run K are legal; in-body / non-succeeded / prefix-broken / since-deleted / root
   selections are refused with the correct §5 reason.
6. Loops, parallel, and plain Resume are unchanged; a non-terminal source is refused whole on every
   surface.

## 10. Decision map

| § | Topic | Originating ticket | Normative doc |
|---|-------|--------------------|---------------|
| 2 | Boundary, dispositions, legal-K, superset | #427 (map) | `CONTEXT.md` §Resume |
| 3 | Wire = source run id; engine resolves the path | #429 | ADR 0032 |
| 4 | Engine mechanism (suppression set; per-level override) | #428, #433 | ADR 0035, ADR 0036; research docs |
| 5 | Precondition, legal K, refusal taxonomy | #429 | ADR 0032 |
| 6 | Successor provenance, persistence, schema bump | #429 | ADR 0032 |
| 7.1 | Designer `Resume from …` button | #430 | ADR 0033, designer-spec.md § Resume from here |
| 7.2 | CLI `--from` resume flag | #431 | issue #431 |
| 7.3 | CLI `--list-eligible` listing | #441 | ADR 0034, resume-eligibility-listing.md |
| 8 | Out of scope | #427 (map) | — |
