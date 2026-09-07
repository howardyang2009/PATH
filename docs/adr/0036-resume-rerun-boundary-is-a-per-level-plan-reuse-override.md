# The rerun boundary is a per-level plan-reuse override, so K can descend into a nested workflow

Status: accepted

A nested K needs the **opposite** of what
[ADR 0035](0035-resume-rerun-boundary-is-a-suppression-set-on-the-two-reuse-producers.md) does. ADR 0035's
suppression set is computed once, root-run-only, and deliberately withheld from every child run
(`run-workflow.ts:458-467`), so a ≥K nested `workflow` node gets its counterpart refused and its whole
subtree re-runs. But a K that sits **inside** a nested `workflow` file wants **partial** reuse inside
that child run — reuse the inner prefix, re-run from K onward — which requires the boundary to reach a
child's `planReuse`, the one place ADR 0035 withholds it. A flat root-only id set also cannot express a
boundary that differs per level of the descent. So Resume-from-chosen-K
([#433](https://github.com/howardyang2009/PATH/issues/433), part of map
[#427](https://github.com/howardyang2009/PATH/issues/427)) generalizes the boundary from a root-only set
to a **per-level plan-reuse override**: `ResumeInput.rerunFromNodePath: string[]` (the descent path of
node ids root→…→K) and a per-level `RunResume.rerunSuffix` (the remaining path from this level down).
Each on-path level derives two sets from its own body and its own suffix head B — `suppress` (Producer A,
B and everything after it) and `rerunEntire` (Producer B, after-B only) — that differ by **exactly B**,
and only when B is intermediate. That one-element gap is the third disposition, **descend**. The full
mechanism map is [docs/research/resume-from-nested-k-mechanism.md](../research/resume-from-nested-k-mechanism.md);
the wire representation and validation that feed the path are
[ADR 0032](0032-resume-from-k-boundary-representation-and-successor-provenance.md).

## Considered Options

### How the boundary reaches a nested level

- **A per-level suffix chain threaded through each on-path run** (chosen). The root seeds
  `rerunSuffix = rerunFromNodePath`; each descent into the path-node passes `suffix.slice(1)`, and every
  off-path sibling passes `[]`. On-path-ness is structural — only the node whose id equals the suffix
  head receives a tail — so node ids stay file-scoped by construction, without the "root only" rule ADR
  0035 relied on. File-scoping is preserved by **on-path only**, threaded structurally, so a nested
  file's coincidental id collision can never suppress the wrong node.
- **Keep the root-only set and force a ≥K nested workflow entire (ADR 0035 alone).** Rejected: it is
  the whole point being lifted. It re-runs an entire nested subtree when the operator asked to reuse the
  nested prefix and re-run only from K inside it. It cannot express a nested K at all.
- **One flat id set covering every level.** Rejected. The boundary differs per level of the descent (a
  different B at each depth), and a single set cannot say "reuse before B here, descend into B, re-run
  after B" independently at each level. The boundary is a chain, one boundary per level, not one set.

### An id chain or an index chain

- **A chain of node ids** (chosen). Each path element survives a rename or move by id (`CONTEXT.md`
  §Identity), matching how ADR 0032 matches the path against the current file (a rename survives, a
  delete fails). The cost is one `findIndex` per level at set-build time.
- **A chain of top-level indices.** Rejected, same as ADR 0035's index-range rejection, one level down:
  an index chain breaks the moment any level reorders under an edit.

## Consequences

- **Two producers, one guard each, applied at every on-path level.** Producer A: `planReuse` takes an
  optional `suppress` set and skips a member id — passed now at **every on-path level** (contrast ADR
  0035's root-only pass), keyed off this run's own `rerunSuffix`, not `parentRunId === null`. Producer B:
  the descent site reads `rerunSuffix` to choose one of three dispositions for a child `workflow` node —
  **reuse/off-path** (before B: already short-circuited in the plan), **rerun-entire** (after B, or B == K:
  counterpart `undefined`, child seeds fresh), or **descend** (intermediate B: re-enter the counterpart
  and hand it `suffix.slice(1)`). `suppress` and `rerunEntire` are equal when B is a leaf and differ by B
  when B descends; that gap is the descend disposition, which no single ADR-0035 set can express.
- **Cascade-up is the after-B rule per level, not a dataflow pass.** Nodes serialized after the
  containing `workflow` node re-run entire at every ancestor level because each level's `rerunEntire`
  holds every run-producing id after that level's B. The suffix chain visits each ancestor and each
  ancestor's set covers its own after-B tail. The reason the operator wants them re-run (their input
  changed) is not computed; the mechanism is the after-B rule, no dataflow analysis.
- **A strict superset in three layers, one code path.** An empty path leaves every `rerunSuffix` empty,
  `suppress` undefined, both guards skipped ≡ plain Resume, byte for byte. A length-1 path `[K]` over a
  top-level K is exactly ADR 0035. K at the auto-boundary reduces to plain Resume. So nested-K ⊇ ADR 0035
  ⊇ plain Resume, all one path.
- **The locus constraint holds one level down.** Each path element is a top-level node of its own level's
  body, so "serialized before/after" is a well-defined top-level index (`findIndex`) at that level. A
  path element nested inside a `branch`/`parallel`/`while-do` body — where "after" is ambiguous across the
  block boundary and a loop body's per-iteration identity is the retired #420/#426 problem — inherits
  #427's out-of-scope limitation, unchanged. Intermediate path-nodes are `workflow` nodes by necessity;
  only K may be a leaf.
- **Validation lives at the wire edge; the engine throws on an internal mismatch.** ADR 0032 (#429)
  validates that the whole path resolves against the current file before any successor starts (a rename
  survives, a delete fails). The engine therefore treats a per-level `i < 0` as an internal invariant
  violation (throw), not a silent degrade to plain Resume. An intermediate B whose counterpart is absent
  (only reachable if validation was skipped) over-re-runs rather than mis-reuses — safe, but a sign the
  gate was bypassed.
- **Provenance and rows are unchanged from ADR 0032.** The successor persists the path as
  `rerunFromNodePath` (`{nodeId, nodeName}[]`, null on plain Resume), a read denormalization derivable
  from the successor's own rows; `resumed_from_root_run_id` stays one hop; ≥K nodes write fresh
  `succeeded` rows and <K nodes write reuse rows, so `RunRecord` needs no new field.
