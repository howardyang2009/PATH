import type { ConfigObject, JsonValue } from "@path/schema";
import { stopCause } from "./cancellation.js";
import { describeInterpolationError, interpolateValue, interpolationScope } from "./interpolate.js";
import { OutputParseError, parseStepOutput } from "./parse-output.js";
import type { StepRequest, StepResult } from "./plugin/seam.js";
import type { Cancellation, NodeExecContext, RunContext, SeqOutcome } from "./run-context.js";
import type { StepEmitter } from "./run-emitter.js";

/**
 * **Leaf steps**: every step type except `workflow`, dispatched through the frozen plugin registry to
 * one Worker (ADR 0021 sub-8). This module owns the whole leaf path — worker selection, the
 * `StepRequest` the engine builds, the processor slot, and the engine-owned shaping of whatever the
 * worker returned (`settleStepResult`, ADR 0024). `runNode` calls `runLeafStep`; a Complete replay
 * lands its supplied output through `finishSucceeded`, the same success tail.
 */

/**
 * A leaf step node, read structurally rather than by a closed union: the engine no longer knows every
 * leaf type at compile time (a plugin folder contributes its own), so a leaf runner reads the envelope
 * keys it owns and treats the plugin's own `fields` as an open bag keyed off `registry[type].fields`.
 */
export interface LeafStepNode {
  type: string;
  id: string;
  name: string;
  worker?: string;
  config?: ConfigObject;
  input?: JsonValue;
  parse?: "text" | "json";
  publish?: { [key: string]: JsonValue };
  [field: string]: unknown;
}

/**
 * What one step needs: the run it belongs to, the sequence it sits in, and its own effective config.
 * Every other input a step runner reads is reachable through `run` or `exec`.
 */
export interface StepContext {
  run: RunContext;
  exec: NodeExecContext;
  /** This step's config: the file's effective config with the step's own shadowing it (format §8). */
  stepConfig: ConfigObject;
  /**
   * A leaf runner reports its minted step emitter here, so `runNode` — which applies the publish and
   * therefore holds the post-step context — can snapshot that context under this step's own run id
   * (the per-step `context.json`). Set by `runNode`; a prompt step mints its emitter only after it
   * holds a processor slot, so the callback fires at that point, not before.
   */
  onLeafStep?: (step: StepEmitter) => void;
}

/** What `settleStepResult` needs to turn one worker's `StepResult` into a leaf step's terminal outcome. */
export interface SettleStepResult {
  /** This step run's emitter — the door every terminal observation of the step passes through. */
  step: StepEmitter;
  /** The node, for the name the engine prefixes onto a worker error and the `parse` it applies to a string. */
  node: { name: string; parse?: "text" | "json" };
  /** What the worker returned (ADR 0021 sub-8) — the only two outcomes a worker reports. */
  result: StepResult;
  /** The worker's `meters` flag: a `step-usage` observation is emitted only for a metering worker. */
  meters: boolean;
  /** The step's kill signal — a `parallel` block's or the operator's; `aborted` is what makes it `cancelled`. */
  signal?: AbortSignal;
  /** The enclosing block's cancellation, read for the cause the `run-cancelled` narrates. */
  cancellation?: Cancellation;
}

/**
 * The whole engine-owned mapping from a worker's `StepResult` to a leaf step's `SeqOutcome`, and the
 * one place it lives (#349's class of bug). A worker reports only `succeeded`/`failed` and self-judges
 * which — the SDK-specific "is this success frame really an error" verdict is correctly the worker's,
 * not the engine's (ADR 0020 sub-5). Everything the *engine* does with whatever the worker returned is
 * here, in order, so the sequence and its edge cases are one testable unit rather than spread across the
 * dispatch that calls the worker:
 *
 * 1. **stderr rides every outcome.** Captured diagnostic text (ADR 0020 sub-7) lands in the audit blob
 *    regardless of how the step ended — a cancelled or failed step's diagnostics are still recorded.
 * 2. **`cancelled` outranks the worker's own verdict.** The engine derives it from `signal.aborted`, not
 *    the worker's status (ADR 0021 sub-7): a failing sibling branch or an operator's cancel killed the
 *    worker in flight, and this relabels whatever it returned as `cancelled` so no publish from it lands.
 *    The `run-cancelled` narration carries the cause — `sibling-failed` (its run named by `causeRunId`),
 *    `sibling-succeeded` (a `wait-one` winner, no cause run — wait-one-join.md §5), or `operator` (a root
 *    cancel, also no cause run) — then the `cancelled` `step-finished`, the pair in order.
 * 3. **usage is leaf-only, from a metering worker, and precedes the finish** (§5.7): a step that died
 *    mid-conversation still spent tokens, so it is emitted before a `failed` finish too — but not for a
 *    `cancelled` step, which returns above.
 * 4. **A `failed` worker's error is prefixed with the node name** (ADR 0021 sub-6): the worker names no
 *    step, so every leaf type's failure reads `step "<name>": <worker error>`, and the step's own run is
 *    the cause a cancelling sibling points at (`causeRunId`).
 * 5. **A `succeeded` worker's output gets `parse: "json"`** (format doc §6.5), applied to a *string* only
 *    (ADR 0021): a worker whose output is already a JSON value hands it straight through. A parse failure
 *    fails the step with its own run as the cause. Keeps the parse/finish shape identical across every
 *    leaf type so they can't drift.
 */
export async function settleStepResult(args: SettleStepResult): Promise<SeqOutcome> {
  const { step, node, result, meters, signal, cancellation } = args;

  // 1. stderr rides every outcome, into the audit blob.
  if (result.status !== "awaiting" && result.stderr !== undefined) await step.stderr(result.stderr);

  // 2. The engine owns `cancelled`, derived from the signal rather than the worker's reported status,
  // and the cause from the cancellation authority (`cancellation.ts`) rather than re-reading it here.
  if (signal?.aborted) {
    await step.cancelled(stopCause(cancellation));
    return { status: "cancelled" };
  }

  // 2b. A worker that returned `awaiting` (person-activity) parks the leaf and the engine tears down
  // (ADR 0039/0041): no held process, no in-memory deferred. The step transitions running -> awaiting
  // (emitted as `step-awaiting`, persisted with no `finished_at`) and the walk stops here — the
  // `awaiting` outcome propagates up like a non-success, leaving every enclosing run `running`. The
  // parked leaf is resolved later by a Complete replay from the root (ADR 0041), which reaches this
  // same leaf run and writes its output through the CAS, never through this call.
  if (result.status === "awaiting") {
    // The worker's echoed `assignee` (#488) rides the `step-awaiting` record; a park that named none
    // carries `null`. The engine reads it as an opaque string, masked at the emit choke point.
    await step.awaiting({ assignee: result.assignee ?? null });
    return { status: "awaiting" };
  }

  // 3. Leaf-only spend (§5.7), from a metering worker only: recorded here, never rolled up — subtree
  //    figures are a read-time SUM. Emitted for a failed step too, before its finish.
  if (meters && (result.usage !== undefined || result.estimatedCostUsd !== undefined)) {
    await step.usage({ usage: result.usage ?? null, estimatedCostUsd: result.estimatedCostUsd ?? null });
  }

  // 4. A worker failure: prefix the node name and end the step, its own run the cancelling cause.
  if (result.status === "failed") {
    const error = `step "${node.name}": ${result.error}`;
    await step.finished({ status: "failed", error });
    return { status: "failed", error, causeRunId: step.runId };
  }

  // 5. Success: `parse: "json"` on a string result, then finish.
  return finishSucceeded(step, node, result.output);
}

/**
 * The shared success tail: apply `parse: "json"` to a string output, then emit the succeeded finish.
 * Both a worker's own success (section 5) and an awaiting step's external completion (#462) land
 * here, so a person-activity node declaring `parse: "json"` gets the same parsing a leaf worker does.
 */
export async function finishSucceeded(
  step: StepEmitter,
  node: SettleStepResult["node"],
  rawOutput: JsonValue,
): Promise<SeqOutcome> {
  let output: JsonValue = rawOutput;
  if (node.parse === "json" && typeof rawOutput === "string") {
    try {
      output = parseStepOutput(rawOutput);
    } catch (err) {
      if (!(err instanceof OutputParseError)) throw err;
      const parseError = `step "${node.name}": ${err.message}`;
      await step.finished({ status: "failed", error: parseError });
      return { status: "failed", error: parseError, causeRunId: step.runId };
    }
  }
  await step.finished({ status: "succeeded", output });
  return { status: "succeeded", output };
}

// A never-aborting signal for a leaf run outside any `parallel` block and with no operator abort:
// `StepRequest.signal` is required (a worker always has one to chain onto), but a top-level step in a
// non-cancellable run has no enclosing signal. One shared instance — it never fires.
const NEVER_ABORT = new AbortController().signal;

/**
 * A leaf step of any type: dispatch through the frozen registry to the selected worker and map its
 * `StepResult` (ADR 0021 sub-8). Leaf dispatch is one `(type, worker-name)` lookup with no built-in
 * branch — `binary`/`prompt` are two plugin folders like any other. The engine builds the
 * `StepRequest` (interpolated `fields`, `$env`/`$secret`-resolved `config`, `input`, `cwd`, `signal`),
 * awaits the worker's `run`, and owns the terminal shaping: `cancelled` is derived from
 * `signal.aborted` (a worker never reports it — ADR 0021 sub-7), `usage`/`estimatedCostUsd` ride from
 * a metering worker, `stderr` is captured for the audit blob regardless, and `parse: "json"` applies
 * to a string result only.
 *
 * The processor-concurrency slot is the engine's: a worker whose descriptor sets `needsProcessorSlot`
 * runs under one acquired slot, held for the call (mvp spec §5.5, ADR 0021 sub-5). Its step row starts
 * only once the slot is really held, so a step that cannot get one simply waits; an uncapped worker
 * (`binary`'s `spawn`) never queues. A thrown exception is *not* caught into a failed step: a worker
 * that means "this step failed" returns `failed`, and a throw propagates as an engine fault (ADR 0020
 * sub-5), masked on the way out of `runWorkflow`.
 */
export async function runLeafStep(node: LeafStepNode, stepInput: JsonValue, ctx: StepContext): Promise<SeqOutcome> {
  const plugin = ctx.run.runtime.registry[node.type];
  if (!plugin) {
    // Unreachable through a schema-validated file — the load rejects a type no registry contributes.
    // A hand-constructed node can still reach here, so it fails the run loudly rather than silently.
    return { status: "failed", error: `step "${node.name}": unknown step type "${node.type}" — no plugin contributes it` };
  }
  // Four-tier dispatch resolution (ADR 0044), first hit wins: a step's explicit `worker` pin; the
  // operator's run-wide `launchWorkerDefaults[type]`; the owning file's `worker_defaults[type]`; the
  // plugin's own `defaultWorker`. The two default tiers differ by scope: the **launch** table lives on
  // the run tree's shared `runtime`, so it reaches every un-pinned step of every file — a nested
  // `workflow`-ref run swaps `file` but keeps `runtime`, so a launch default beats a *child's* file
  // default too (the operator's run-wide intent outranks an author's per-file default; only a
  // `node.worker` pin sits above it). The **file** table lives on `ctx.run.file`, the file that owns
  // this node, so it stays file-scoped for free (it never crosses a ref boundary). Both are a
  // *selection* by name; registry-relative validity is checked elsewhere per tier (#506) — until those
  // nets exist, a table naming a worker the type does not ship falls through to the `has no worker`
  // failure just below, loud not silent.
  const workerName =
    node.worker ??
    ctx.run.runtime.launchWorkerDefaults?.[node.type] ??
    ctx.run.file.worker_defaults?.[node.type] ??
    plugin.defaultWorker;
  const descriptor = plugin.workers[workerName];
  if (!descriptor) {
    return { status: "failed", error: `step "${node.name}": step type "${node.type}" has no worker "${workerName}"` };
  }

  // The plugin's own `fields` are the node keys its `fields` fragment names; the engine interpolates
  // each against config+context before the worker reads them (ADR 0022 acceptance #4). Every other key
  // on the node is an envelope field the engine owns, not the worker's.
  const scope = interpolationScope(ctx.stepConfig, ctx.exec.context);
  let fields: JsonValue;
  try {
    const raw: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(plugin.fields)) {
      const value = (node as { [k: string]: unknown })[key];
      if (value !== undefined) raw[key] = value as JsonValue;
    }
    fields = interpolateValue(raw, scope);
  } catch (err) {
    return { status: "failed", error: describeInterpolationError(node.name, err) };
  }

  const release = descriptor.needsProcessorSlot ? await ctx.run.runtime.semaphore.acquire() : undefined;
  try {
    // The step's run id is minted (and its row starts) only once any processor slot is really held.
    const step = ctx.run.emitter.step(node);
    ctx.onLeafStep?.(step);
    await step.started({ stepType: node.type, workerName, input: stepInput });

    const request: StepRequest = {
      fields: fields as StepRequest["fields"],
      input: stepInput,
      // The worker reads real values: the effective config is what it is — `$env` resolved and
      // `$secret` unwrapped where the config was materialized (ADR 0022 sub-4, `resolveEffectiveConfig`).
      // Masking stays a persistence-boundary concern only (ADR 0020).
      config: ctx.stepConfig as unknown as StepRequest["config"],
      cwd: ctx.run.fileDir,
      signal: ctx.exec.signal ?? NEVER_ABORT,
    };
    const result = await descriptor.run(request);

    // Everything the engine does with whatever the worker returned lives behind one seam
    // (`settleStepResult`): stderr capture, the signal-derived `cancelled` relabel, leaf-only usage,
    // the node-prefixed failure, and `parse: "json"` on success — in that order, testable on its own.
    return settleStepResult({
      step,
      node,
      result,
      meters: descriptor.meters,
      signal: ctx.exec.signal,
      cancellation: ctx.exec.cancellation,
    });
  } finally {
    // The processor is gone by now; holding its slot any longer would shrink the cap.
    release?.();
  }
}
