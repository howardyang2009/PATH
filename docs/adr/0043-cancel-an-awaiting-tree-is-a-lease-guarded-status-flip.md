# Cancel of an awaiting tree is a lease-guarded status flip, and Resume stays terminal-only

Status: accepted

A person-activity step parks its run at `awaiting` and the engine tears down ([ADR 0039](0039-complete-is-a-durable-engine-re-invocation-over-the-appendable-tree.md), [ADR 0041](0041-awaiting-continue-is-a-replay-from-root-over-the-appendable-tree.md)), so a parked tree has **no held process**. Cancel of such a tree therefore cannot be the abort-controller teardown the live path performs; it is a **status flip** that writes the terminal `cancelled` status directly into the store, guarded by the same per-root-run expiring lease [ADR 0041](0041-awaiting-continue-is-a-replay-from-root-over-the-appendable-tree.md) uses for Complete. Resume is unchanged: it operates only on a **terminal** predecessor ([ADR 0001](0001-resumed-run-is-a-successor-run.md)), so a non-terminal `awaiting` tree — whose root reads `running` ([ADR 0038](0038-awaiting-is-a-leaf-only-status-parents-do-not-propagate.md)) — is not Resumable; the operator Cancels first (terminalizing the tree to `cancelled`), then Resumes.

## What Cancel writes

Cancel is a root-level action (`POST /v0/runs/:root_run_id/cancel`). Under the lease it marks **every non-terminal run in the tree** `cancelled`: each `awaiting` leaf by CAS (`awaiting → cancelled`), each `running` in-process leaf by aborting its worker and then `cancelled`, each enclosing `running` workflow-run, and the root. Already-`succeeded` leaves and any terminal subtree are untouched — the run record is the audit trail and must survive the cancel. The root emits the existing `run-cancelled` log event; the flipped leaves write `cancelled` status rows with **no** new per-leaf log event and **no** sibling cancel-cause. Operator cancel is not `sibling-failed` or `sibling-succeeded` ([ADR 0042](0042-awaiting-inside-parallel-joins.md)); it is the root action reaching each non-terminal member, so the log stream stays a leaf-level lifecycle narrative ([ADR 0038](0038-awaiting-is-a-leaf-only-status-parents-do-not-propagate.md)) with the tree-level `run-cancelled` naming the operator act.

## The cancel route taxonomy

An `awaiting` leaf is process-less **by construction** (ADR 0039), so "no live process" is the healthy state of a parked tree and is safe to flip. A `running` leaf is supposed to have a driving process; a `running` leaf with no local controller is an unknown execution state — a crash-orphan, or a run driven by another server or CLI process against the same `path.db` — that the route cannot safely terminate. The route discriminates on the status of the non-terminal frontier, checks in order, first match wins:

1. root row missing → `404`.
2. root terminal → `409` already finished.
3. root `running` **and** `live.cancel` succeeds (this process holds the controller, including a live sibling beside a parked `awaiting` one) → `202`: abort the live workers **and** flip the parked sibling leaves under the lease. This extends the prior live path, which aborted controllers only.
4. root `running`, no local controller, non-terminal frontier **all `awaiting`** → `202`: flip under the lease. This is the new path, and it is what makes Cancel-then-Resume possible.
5. root `running`, no local controller, **any leaf `running`** → `409` cannot cancel. The prior crash-orphan refusal (`not executing in this server process`), preserved unchanged.
6. per-root lease held by a concurrent Complete or Cancel → `409` lease-held; the operator retries (never queued, [ADR 0041](0041-awaiting-continue-is-a-replay-from-root-over-the-appendable-tree.md)).

A **mixed frontier** — some leaves `awaiting`, one leaf `running` with no local controller — hits path 5 and refuses the **whole** Cancel. A partial cancel that flipped the `awaiting` leaves and left a possibly-live `running` leaf behind is worse than a clean refusal the operator retries once the `running` leaf's state is known.

## Cancel versus Complete

Both mutate leaves, so both take the same per-root-run lease. If a Complete already won a leaf's CAS (`awaiting → succeeded`), Cancel leaves that leaf `succeeded` and cancels the rest. If Cancel already flipped a leaf to `cancelled`, a later Complete lands the existing `409` not-`awaiting` (#466 taxonomy). A Complete mid-replay holds the lease until its tail parks or terminates; a concurrent Cancel gets `409` lease-held (path 6) and retries. No new race rule is added: the shared lease plus the existing leaf-CAS taxonomy cover every ordering.

## Resume interaction

- **Terminal-only Resume, no direct resume of a live awaiting tree.** Resume's model is successor-of-a-terminal-predecessor ([ADR 0001](0001-resumed-run-is-a-successor-run.md)): the predecessor freezes the instant a successor starts. A live `awaiting` tree is not frozen — Complete can still advance it — so a direct Resume would create two rival advance-paths (Complete versus Resume) over one unfrozen tree. The route already `409`s a non-terminal root (`only a finished run can be resumed`). The operator Cancels first, then Resumes.
- **Re-run versus reuse is cause-blind Resume, unchanged.** A leaf that terminated non-`succeeded` (parked then `cancelled` by this Cancel, or cancelled by `sibling-failed`) re-runs on Resume; the person-activity worker returns `awaiting` again and the branch re-parks. A leaf that Completed before termination has a `succeeded` row and reuses its output (reuse row, direct-to-source). Both are the existing cause-blind resume ([ADR 0042](0042-awaiting-inside-parallel-joins.md)); neither needs a new rule.
- **Resume-from-K may name a Completed person-activity leaf.** A legal K is a `succeeded`, top-level node with a fully-succeeded prefix. A person-activity leaf that Completed qualifies: chosen as K it re-runs entire (the worker returns `awaiting` again, the successor re-parks, the person redoes the activity) while the prefix `<K` reuses. An `awaiting`-never-completed or `cancelled` leaf is not `succeeded`, so it can never be a chosen K — it is only ever plain Resume's auto-boundary. Standard Resume-from-K, no new mechanism.

## Considered options

- **One Cancel path (abort-controller only).** Refuse a Cancel when no live controller holds the run, as the route does today. Rejected: it leaves a parked `awaiting` tree un-cancelable, and since Resume is terminal-only, un-terminalizable — the operator could neither advance nor abandon a parked run. Cancel-then-Resume, the settled way to restart an `awaiting` tree, would be impossible.
- **Resume a live `awaiting` tree directly.** Skip the Cancel step and let Resume operate on a non-terminal `awaiting` root. Rejected: it demands freezing a tree that is not terminal, contradicting the successor-of-terminal model ([ADR 0001](0001-resumed-run-is-a-successor-run.md)), and it puts Resume and Complete in a race to advance the same unfrozen tree.
- **Flip the awaiting leaves on a mixed frontier and refuse only the running leaf.** Rejected: a partial cancel that leaves a possibly-live `running` leaf executing is a worse outcome than a whole-tree refusal the operator retries once the leaf's state is known.

## Consequences

- The Cancel route gains a store-flip path beside the abort path, and the prior live path (3) now also flips parked sibling leaves rather than aborting controllers alone. The crash-orphan refusal (5) is preserved byte-for-byte.
- No new log event and no new cancel-cause: `run-cancelled` at the root, `cancelled` status rows at the leaves.
- No CONTEXT.md glossary change. This ADR records a mechanism (how Cancel and Resume behave for `awaiting` trees), not new vocabulary; the glossary stays implementation-free.
