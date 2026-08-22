import type { JsonValue, Worker } from "@path/schema";
import type { Trace } from "./condition.js";

/**
 * Thrown by `observe` to signal the engine must **fail the run** rather than crash — the
 * audit-first policy for a log backend write failure (mvp spec §8.2). `runWorkflow` catches this
 * specific type, ends the run as failed, and drives a best-effort terminal `run-finished`; any other
 * thrown error is treated as a bug and propagates unchanged.
 */
export class ObserverError extends Error {}

/**
 * How a run/step ended — shared by the `step-finished` and `run-finished` observations (identical
 * shape). A failure
 * carries its `error` message so logging (#19) can put it on the `step-finished` event; for a
 * binary step that message already embeds the exit code + short stderr tail (mvp spec §8.1). A
 * `cancelled` outcome (#24) has neither output nor error — an in-flight sibling of a failing
 * parallel branch that the engine killed best-effort (mvp spec §5.6); its cause is narrated
 * separately by the `run-cancelled` event.
 */
export type RunOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error?: string }
  | { status: "cancelled" };

/**
 * One typed record of run activity the engine emits to its observer (#62) — the **full** set,
 * distinct from the narrower `LogEvent` narrative (logging/log-event.ts).
 *
 * Two things separate an observation from a log event, and both are why this union exists:
 *
 * 1. **Observations carry payloads.** `input`, `output`, `context` and `stderr` ride the
 *    observation, because persistence writes them to blobs (mvp spec §6). The log stream carries
 *    only blob refs, so `toLogEvent` strips them.
 * 2. **Four members are never narrated.** `step-stderr`, `step-usage`, `context-changed` and
 *    `step-context` have no log event at all — they exist purely for persistence.
 *
 * Every observation reaching an observer is **already secret-masked** (mvp spec §8.3): masking
 * happens at the engine's single emit choke point, not in a wrapper a caller might forget to
 * apply. Backends inherit that guarantee (see logging/log-backend.ts).
 *
 * Members mirror the run/step/control-node lifecycle one-for-one; see each field's meaning on the
 * shared envelope below. `runId` is the run the observation belongs to and `rootRunId` its tree's
 * root, so one observer instance serves an entire nested run tree (#22) without per-run state.
 */
export type Observation =
  /**
   * A workflow-run begins, before any body node executes. The root run has `parentRunId: null` and
   * `nodeId: null`; a nested workflow-step's run (#22) carries its parent run's id and the
   * `workflow` node's id — workflow-as-step means the child run *is* that step's run, so a nested
   * workflow-run is reported here (with its own context) rather than as `step-started`.
   *
   * `worker` is this workflow-run's own file worker (inheritance never crosses the file boundary) —
   * every workflow-run is its file's implicit root workflow-step (invariant 2), so logging emits its
   * `step-started`/`step-finished` as the run's own lifecycle (mvp spec §8.1).
   */
  | {
      type: "run-started";
      runId: string;
      rootRunId: string;
      parentRunId: string | null;
      nodeId: string | null;
      nodeName: string | null;
      input: JsonValue;
      worker: Worker;
      /**
       * The predecessor's root run id (#173), set only on a resumed tree's **root** run-started —
       * the one identity fact that marks this fresh root run as a successor of another (#168). Absent
       * for an ordinary run and for every nested run, whose predecessor is the tree's, not its own.
       * Persistence records it on the root row's `resumed_from_root_run_id`; no other observer reads it.
       */
      resumedFromRootRunId?: string;
      /**
       * The producing workflow's source identity (#202, ADR 0006): its durable GUID `id`, human
       * `name`, and the launcher-supplied path (relative to the store dir). Set **only on the root
       * run's** run-started — a nested workflow-run's own file identity is not recorded, its producing
       * node already being named by `nodeId`/`nodeName`. Persistence writes the trio to the root row's
       * `workflow_id`/`workflow_name`/`workflow_path`. `workflowPath` is absent when the launcher
       * supplied none (a server-hosted run); the GUID/name are always present on the root.
       */
      workflowId?: string;
      workflowName?: string;
      workflowPath?: string;
    }
  /** A leaf step run begins — its input/command/cwd are resolved and it's about to execute. */
  | {
      type: "step-started";
      runId: string;
      rootRunId: string;
      parentRunId: string;
      nodeId: string;
      nodeName: string;
      stepType: string;
      worker: Worker;
      input: JsonValue;
    }
  /** A binary step's captured stderr — never passed downstream (format doc §4.2), audit only. */
  | { type: "step-stderr"; runId: string; rootRunId: string; stderr: string }
  /**
   * What one LLM step run spent (#25, mvp spec §5.7, §7): `usage` is the worker's real token counts,
   * `estimatedCostUsd` the SDK's client-side estimate at API list prices. Reported **leaf-only**, on
   * the prompt-step run where the tokens were spent — a workflow-run never reports a total of its
   * children's spend, since subtree figures are a read-time SUM. Emitted before `step-finished`, and
   * for a failed step too: a step that died mid-conversation still spent tokens.
   */
  | {
      type: "step-usage";
      runId: string;
      rootRunId: string;
      usage: JsonValue | null;
      estimatedCostUsd: number | null;
    }
  /** A leaf step run finished. */
  | ({ type: "step-finished"; runId: string; rootRunId: string } & RunOutcome)
  /** A workflow-run's context changed, after a publish landed — each workflow-run has its own. */
  | { type: "context-changed"; runId: string; rootRunId: string; context: JsonValue }
  /**
   * A leaf step run's snapshot of the enclosing workflow-run's context, taken right after the step
   * finished and its publish (if any) landed — so the step's own directory records the context as it
   * stood when that step ran, and the viewer can follow the context evolve step by step. `runId` is
   * the leaf step run's own id (not the workflow-run's), so persistence writes it under that step's
   * directory alongside its `input.json`/`output.json`. Persistence-only, never narrated.
   */
  | { type: "step-context"; runId: string; rootRunId: string; context: JsonValue }
  /**
   * A `parallel` join applied at block end. For `collect` (#24) all branches succeeded and their
   * buffered publishes landed in branch declaration order; for `wait-one` (wait-one-join.md §5) the
   * `winner` branch won the race and only its buffered publishes landed, `branches` naming just the
   * winner. A control-node observation (the block is a logicer, not a run) — `runId` is the enclosing
   * workflow-run, `nodeId` the `parallel` node. `winner` is set only for a `wait-one` join.
   */
  | {
      type: "join-applied";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      branches: string[];
      publishedKeys: string[];
      winner?: string;
    }
  /**
   * A run the engine killed best-effort (#24, #52, mvp spec §5.6): `runId`/`nodeId` identify the
   * cancelled step run and its node. `cause` is why — `sibling-failed` (a `collect` branch failed,
   * `causeRunId` naming that run), `sibling-succeeded` (a `wait-one` branch won the race, so the
   * losers are cancelled — wait-one-join.md §5, no cause run so `causeRunId` is null), or `operator`
   * (a cancel request against the root run, also no cause run). Paired with a `cancelled`
   * `step-finished` for the same run.
   */
  | {
      type: "run-cancelled";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      cause: "sibling-failed" | "sibling-succeeded" | "operator";
      causeRunId: string | null;
    }
  /** A workflow-run finished (root or nested). */
  | ({ type: "run-finished"; runId: string; rootRunId: string } & RunOutcome)
  /**
   * A resumed tree reused a node's recorded work instead of re-running it (#172,
   * resume-restore-semantics.md §6). No `step-started`/`step-finished` is emitted for the reused
   * node and no run row is written — this marker is its whole trace. `runId` is the enclosing
   * re-entered workflow-run (the reuse decision was taken while walking that run's body), `nodeId`
   * the reused node's own id, and `originalRunId` the run in the *original* tree that holds the real
   * data. Fires once per reuse decision — a reused workflow-run collapses its whole subtree into this
   * single event, never one per descendant. Narrated to the log alone (see logging/logging-observer);
   * persistence writes nothing for it (there is no run of its own — invariant 1's spirit).
   */
  | { type: "reuse-marker"; runId: string; rootRunId: string; nodeId: string; nodeName: string; originalRunId: string }
  /**
   * A `checkpoint` node was evaluated (#21). Control-node observations are attributed to the
   * enclosing workflow-step's run (`runId`) + the control node's `nodeId` — a checkpoint has no run
   * of its own (invariant 1). `passed` is the condition outcome; a strict-error evaluation is
   * `passed: false` with the error surfaced as an error leaf inside `trace`. Logging (#19) splits
   * this into the `checkpoint-passed`/`checkpoint-failed` events.
   */
  | { type: "checkpoint-evaluated"; runId: string; rootRunId: string; nodeId: string; nodeName: string; passed: boolean; trace: Trace }
  /**
   * A `branch` arm won (#21): `arm` is the winning arm's index, or `"else"` for the fallback (which
   * has no condition, so `trace` is null).
   */
  | {
      type: "branch-taken";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      arm: number | "else";
      trace: Trace | null;
    }
  /**
   * No `branch` arm matched and there was no `else` (#21) — this fails the run (§5.2). Carries every
   * arm's `trace`.
   */
  | { type: "branch-no-match"; runId: string; rootRunId: string; nodeId: string; nodeName: string; traces: Trace[] }
  /**
   * A `while-do` iteration is about to run (#23): `iteration` is 1-based; `trace` is the condition
   * check that passed (true) leading to this iteration.
   */
  | { type: "iteration-started"; runId: string; rootRunId: string; nodeId: string; nodeName: string; iteration: number; trace: Trace }
  /**
   * A `while-do` loop exited (#23): `reason` is `condition-false` (the normal exit) or
   * `max-iterations-exceeded` (which fails the run — spec §5.2/§5.6); `iterations` is the number of
   * completed iterations; `trace` is the final condition check (the false one, or the still-true one
   * at the cap).
   */
  | {
      type: "loop-exited";
      runId: string;
      rootRunId: string;
      nodeId: string;
      nodeName: string;
      reason: "condition-false" | "max-iterations-exceeded";
      iterations: number;
      trace: Trace;
    };

/**
 * The engine's audit seam: one required method, called at exactly the points persistence (#18) and
 * logging (#19) need to observe. The engine itself never touches fs/db directly — a caller with
 * nothing to observe passes no observer at all.
 *
 * **Why one method and not a hook per lifecycle point (#62).** A *sink* may legitimately care about
 * a subset — persistence ignores every control-node observation, and that is correct. A *decorator*
 * may not: a wrapper that forwards some observations and drops the rest silently deletes them.
 * Fourteen independently-optional hooks made that distinction unenforceable, and the masking
 * decorator shipped covering 6 of them, so eight kinds of observation vanished for any workflow
 * declaring a `$secret`. With one required method, a sink switches and ignores what it likes, while
 * a decorator cannot be partial — there is nothing to be partial about.
 *
 * **What an implementer may rely on:**
 * - Observations arrive **already secret-masked** (mvp spec §8.3) — the engine masks at its single
 *   emit choke point, so no caller has to remember to wrap anything.
 * - Every observation carries `rootRunId`, so one instance serves an entire nested run tree (#22)
 *   without hidden per-run state.
 * - A root run's `run-started` precedes every other observation of its tree, and its `run-finished`
 *   follows every other — the logging observer opens and closes its backends on that guarantee.
 *
 * Throwing `ObserverError` fails the run (audit-first, §8.2); any other throw is a bug and
 * propagates.
 */
export interface RunObserver {
  observe(o: Observation): void | Promise<void>;
}


/**
 * Fans one observation out to several observers in argument order, awaiting each — the dumb ordered
 * fan-out `Project.execute` builds its audit pipeline from (project.ts). A throw (e.g. an
 * `ObserverError` from a log backend failure) propagates from the composite, so the engine still sees
 * it and fails the run; observers after the thrower do not run.
 *
 * **Argument order is load-bearing.** `Project.execute` is the one place a run's observers are
 * assembled (#64) — the CLI and the server both reach the engine through it, neither composing an
 * observer of its own. It orders the pipeline persistence → logging → appended observers for two
 * reasons, each now pinned by a test in `project.test.ts` rather than by this comment alone:
 *
 * - **Persistence before logging.** A log backend write failure raises `ObserverError`, which aborts
 *   the remaining observers for that observation. With logging first, a run whose audit failed would
 *   also have no run row — the row is the record that survives a failed audit, so it must land first.
 *   ("keeps the run row when a log backend throws".)
 * - **Appended observers last.** The server's capture observer resolves the deferred that sends HTTP
 *   202 (`post-runs.ts`), and a client may `GET /v0/runs/:id` the instant that response lands. Running
 *   it before the persisted observer races the row it will read; before the logging observer, it races
 *   the hub channel its SSE stream subscribes to. ("runs extraObservers after the built-in pair".)
 *
 * This function stays order-agnostic on purpose: it fans out in the order handed to it. The order is a
 * property of the single assembly that builds it, which is where the tests aim.
 */
export function composeObservers(...observers: RunObserver[]): RunObserver {
  return {
    async observe(o) {
      for (const observer of observers) await observer.observe(o);
    },
  };
}
