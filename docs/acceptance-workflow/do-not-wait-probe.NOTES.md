# Acceptance workflow: do-not-wait-probe

Resolves issue #216, the synthetic acceptance case for the `do-not-wait` join
([spec](../spec/do-not-wait-join.md)). The sibling of [NOTES.md](./NOTES.md)'s release-notes pipeline
and of [env-secret-probe.NOTES.md](./env-secret-probe.NOTES.md), and like the latter a **seam test** for
one construct rather than the MVP's definition of done.

Driven by `packages/engine/test/acceptance/do-not-wait.test.ts` through the real `path run`: real db,
real blob tree, both log backends, no worker substituted (both the detached branch and the main path are
`binary` steps, so unlike release-notes there is not even a scripted LLM in the way).

## Why synthetic

The `do-not-wait` door was opened **by decision, not by a fired trigger** (spec §1, register #109). No
motivating workflow exists yet; it is a build-ahead, exactly as `wait-one` was. So there is no
non-synthetic case to point at. This workflow is written to exercise the mechanism, not to relieve a real
pain: a block that fires a fire-and-forget side-effect branch and moves on. If a real driver ever
appears, it earns its own non-synthetic case and this one stays as the mechanism's floor.

The release-notes pipeline uses `collect`, `branch`, and `while-do` but no `do-not-wait`, and nothing
else checked in fires a detached branch. So this map brings its own proof, with **no network and no
account** (the side effect is an append to a local file).

## The workflow

One `parallel` block, `join: do-not-wait`, with a single branch `notify`, followed by a main-path step:

1. **`fire`** (`parallel`, `do-not-wait`), then branch **`notify`**, then **`post-signal`** (`binary`):
   appends one `fired` line to `config.signal_file` (the side effect a real branch would post to Slack),
   then holds for `config.branch_delay_ms` and exits `config.branch_exit_code`. The append lands
   **before** the hold, so a branch cancelled mid-hold has still fired exactly once.
2. **`after`** (`binary`, main path): echoes its stdin, which by the default-input chain is the block's
   `{}` output, and publishes it as `seen`. Its printed `{ "seen": "{}" }` is the observable proof the
   block discharged the empty object at the join.

`config` knobs (`signal_file`, `branch_delay_ms`, `branch_exit_code`) are the seams each test drives
through `--set`; the branch itself is unchanged between cases.

## What it pins, one per spec section

| Spec | Exercised by |
| --- | --- |
| §2 launch-and-continue | `after` finishes and prints `{ "seen": "{}" }` before the held branch — the successor ran against the block's `{}` output without waiting |
| §2 / §1.1 enclosing-run barrier | with a held branch, both step rows share one root run and both are `succeeded` before the root returns — the branch is detached from the *block*, not the tree |
| §4 `publish` rejection at load | a `publish` injected into the checked-in branch makes `loadWorkflowTree` reject before any step runs |
| §5 / ADR 0008 failure isolation | `branch_exit_code=7` leaves the branch row `failed` and the root run `succeeded` — a `failed` detached descendant in a `succeeded` subtree |
| §7 / ADR 0009 resume re-fire | killed with the branch in flight (fired once, then `cancelled`), `--resume` re-runs the non-`succeeded` branch and it fires **again** — the side-effect count goes 1 to 2, at-least-once with no short-circuit |

The resume kill mirrors
[release-notes.test.ts](../../packages/engine/test/acceptance/release-notes.test.ts)'s
`killMidFirstRevise`: a real operator cancel (`RunOptions.signal`) driven deterministically off an
observation (here the main-path step finishing, while the branch is still holding), without the
process-signal plumbing an in-process acceptance run cannot use. The main path having already succeeded
when the abort lands is why the root reports `succeeded` with a `cancelled` branch: the operator cancel
(cause `operator`, §6) reaches only the still-live detached branch.

## Deliberately not reached

- **`publish` inside the branch as a *running* case** — it is a load error (§4), so it can never be a
  checked-in workflow that runs. The rejection is pinned by an inject of the forbidden `publish` into a
  copy and an assert that the load fails, not by a green run.
- **Cost roll-up over a failed detached branch** (§8) — the status-blind roll-up that sums a `failed`
  branch's spend needs an LLM branch to have spent anything; both steps here are `binary`, so no tokens
  are burned. That case lives in the engine unit suite (`run-workflow.test.ts`, "sums a failed detached
  branch's token usage into the roll-up"), which scripts an LLM worker for exactly it.
- **All-branches-fail** and **multi-branch cross-cancel absence** (§9, §5) — single-branch here. The
  multi-branch shapes are pinned in `run-workflow.test.ts`.
