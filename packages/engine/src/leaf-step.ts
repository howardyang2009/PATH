import type { ConfigObject, JsonValue } from "@path/schema";
import { stopCause } from "./cancellation.js";
import { describeInterpolationError, interpolateValue, interpolationScope } from "./interpolate.js";
import { OutputParseError, parseStepOutput } from "./parse-output.js";
import type { StepRequest, StepResult } from "./plugin/seam.js";
import type { Cancellation, NodeExecContext, RunContext, SeqOutcome } from "./run-context.js";
import type { StepEmitter } from "./run-emitter.js";

// **Leaf steps**: every step type except `workflow`, dispatched through the frozen plugin registry to one
// Worker (ADR 0021 sub-8). Owns worker selection, the `StepRequest`, the processor slot, and the result.

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

export interface StepContext {
  run: RunContext;
  exec: NodeExecContext;
  /** This step's config: the file's effective config with the step's own shadowing it (format §7). */
  stepConfig: ConfigObject;
  /** Reports the minted step emitter so `runNode` can snapshot the post-step context under its run id. */
  onLeafStep?: (step: StepEmitter) => void;
}

export interface SettleStepResult {
  step: StepEmitter;
  /** The node: the name a worker error is prefixed with, and the `parse` applied to a string output. */
  node: { name: string; parse?: "text" | "json" };
  result: StepResult;
  /** The worker's `meters` flag: a `step-usage` observation is emitted only for a metering worker. */
  meters: boolean;
  /** The step's kill signal — a `parallel` block's or the operator's; `aborted` makes it `cancelled`. */
  signal?: AbortSignal;
  cancellation?: Cancellation;
}

/**
 * The engine-owned mapping from a worker's `StepResult` to a leaf step's `SeqOutcome`, in order: a
 * worker reports only `succeeded`/`failed` and self-judges which (ADR 0020 sub-5). The ordering
 * constraints are `stderr` first, then `cancelled` derived from `signal.aborted` (ADR 0021 sub-7),
 * then leaf-only usage (§5.7), then a node-prefixed failure (ADR 0021 sub-6) or the `parse: "json"`
 * success tail (format doc §6.5).
 */
export async function settleStepResult(args: SettleStepResult): Promise<SeqOutcome> {
  const { step, node, result, meters, signal, cancellation } = args;

  if (result.status !== "awaiting" && result.stderr !== undefined) await step.stderr(result.stderr);

  if (signal?.aborted) {
    await step.cancelled(stopCause(cancellation));
    return { status: "cancelled" };
  }

  // A worker that returned `awaiting` (person-activity) parks the leaf and tears nothing else down
  // (ADR 0039): the walk stops here and a Complete replay resolves it later through the CAS.
  if (result.status === "awaiting") {
    await step.awaiting({ assignee: result.assignee ?? null });
    return { status: "awaiting" };
  }

  if (meters && (result.usage !== undefined || result.estimatedCostUsd !== undefined)) {
    await step.usage({
      usage: result.usage ?? null,
      estimatedCostUsd: result.estimatedCostUsd ?? null,
    });
  }

  if (result.status === "failed") {
    const error = `step "${node.name}": ${result.error}`;
    await step.finished({ status: "failed", error });
    return { status: "failed", error, causeRunId: step.runId };
  }

  return finishSucceeded(step, node, result.output);
}

// The success tail: `parse: "json"` on a string output, then the succeeded finish. A worker's own
// success and an awaiting step's external completion both land here.
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

// A never-aborting signal: `StepRequest.signal` is required, but a top-level uncancellable step has none.
const NEVER_ABORT = new AbortController().signal;

/**
 * A leaf step of any type: dispatch through the frozen registry to the selected worker (ADR 0021
 * sub-8), build the `StepRequest`, and shape the result behind `settleStepResult`.
 *
 * The processor slot is the engine's: a `needsProcessorSlot` worker holds one acquired slot for the
 * call (mvp spec §5.5). A throw is *not* caught into a failed step — a worker that means "this step
 * failed" returns `failed` — so it propagates as an engine fault (ADR 0020 sub-5).
 */
export async function runLeafStep(
  node: LeafStepNode,
  stepInput: JsonValue,
  ctx: StepContext,
): Promise<SeqOutcome> {
  const plugin = ctx.run.runtime.registry[node.type];
  if (!plugin) {
    return {
      status: "failed",
      error: `step "${node.name}": unknown step type "${node.type}" — no plugin contributes it`,
    };
  }
  // Four-tier dispatch resolution (ADR 0044), first hit wins: a step's `worker` pin; the operator's
  // `launchWorkerDefaults[type]`, which lives on the shared `runtime` and so beats a child file's
  // default; the owning file's `worker_defaults[type]`; the plugin's own `defaultWorker`. A table
  // naming a worker the type does not ship falls through to the `has no worker` failure below.
  const workerName =
    node.worker ??
    ctx.run.runtime.launchWorkerDefaults?.[node.type] ??
    ctx.run.file.worker_defaults?.[node.type] ??
    plugin.defaultWorker;
  const descriptor = plugin.workers[workerName];
  if (!descriptor) {
    return {
      status: "failed",
      error: `step "${node.name}": step type "${node.type}" has no worker "${workerName}"`,
    };
  }

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

  const release = descriptor.needsProcessorSlot
    ? await ctx.run.runtime.semaphore.acquire()
    : undefined;
  try {
    // The step's run id is minted (and its row starts) only once any processor slot is really held.
    const step = ctx.run.emitter.step(node);
    ctx.onLeafStep?.(step);
    await step.started({ stepType: node.type, workerName, input: stepInput });

    const request: StepRequest = {
      fields: fields as StepRequest["fields"],
      input: stepInput,
      // The worker reads real values: `$env` resolved, `$secret` unwrapped (ADR 0022 sub-4).
      config: ctx.stepConfig as unknown as StepRequest["config"],
      cwd: ctx.run.fileDir,
      signal: ctx.exec.signal ?? NEVER_ABORT,
    };
    const result = await descriptor.run(request);

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
