import type { JsonValue } from "@path/schema";
import type { StepRequest, StepResult, WorkerDescriptor } from "../../src/plugin/seam.js";

/**
 * What one scripted prompt step returns. A handler receives the request and the 1-based count of
 * how many times *this label* has been asked so far, so a script can answer differently on each
 * pass — the never-passing judge of mvp spec §11's second failure path is exactly that.
 */
export type ScriptedHandler = (request: StepRequest, callNumber: number) => string;

/**
 * Maps a worker request to the script key (the node's name). The `prompt`/`sdk` seam carries no node
 * name (ADR 0021 sub-6 — the engine owns the name and never hands it to a worker), so a scripted
 * worker recovers the identity from the request itself, typically from the interpolated prompt text.
 */
export type ScriptedLabel = (request: StepRequest) => string;

export interface ScriptedCall {
  nodeName: string;
  model: string | undefined;
  input: JsonValue;
}

export interface ScriptedLlmWorker extends WorkerDescriptor {
  /** Every worker request the engine made, in settle order. */
  readonly calls: readonly ScriptedCall[];
  /** The high-water mark of concurrently in-flight processors — the fan-out cap under test (§11.4). */
  readonly maxConcurrent: number;
}

export interface ScriptedWorkerOptions {
  /**
   * Fired synchronously the instant a call is recorded — *before* it settles — so a test can act
   * while a chosen prompt is genuinely in flight. The resume acceptance run (#178) uses it to abort
   * the run mid-`while-do`, the same real cancellation `^C` drives (mvp spec §5.6): the hook aborts,
   * the worker then observes the abort on its own request signal and returns `failed`, and the engine
   * relabels it `cancelled` from the signal, exactly as a live processor's would.
   */
  onCall?: (call: ScriptedCall & { callNumber: number }) => void;
}

/** Fixed per-call spend, so `usage`/`estimated_cost_usd` assertions have a known expected value. */
export const SCRIPTED_USAGE: JsonValue = { input_tokens: 1200, output_tokens: 340 };
export const SCRIPTED_COST_USD = 0.0042;

/**
 * A stand-in for the shipped `prompt`/`sdk` worker (mvp spec §7) that answers from a per-label script
 * instead of spawning a processor. It is the *only* thing faked in the acceptance run: the engine, the
 * real workflow files, git, persistence and logging are all real. Faking it is what makes the pipeline
 * deterministic and free to run in CI — a live processor is neither.
 *
 * It plugs into `runWorkflow` as `workerOverrides.prompt.sdk` (ADR 0021 sub-15). It declares
 * `needsProcessorSlot: true` and holds no semaphore of its own, so the engine's processor cap governs
 * it — each call holds its slot for a turn of the event loop before resolving, so two branches the
 * engine genuinely runs at once overlap here and `maxConcurrent` can observe the cap.
 */
export function createScriptedLlmWorker(
  script: Record<string, ScriptedHandler>,
  label: ScriptedLabel,
  options: ScriptedWorkerOptions = {},
): ScriptedLlmWorker {
  const calls: ScriptedCall[] = [];
  const callsPerLabel = new Map<string, number>();
  let inFlight = 0;
  let maxConcurrent = 0;

  return {
    meters: true,
    needsProcessorSlot: true,
    get calls() {
      return calls;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    async run(request: StepRequest): Promise<StepResult> {
      if (request.signal.aborted) return { status: "failed", error: "cancelled" };

      const nodeName = label(request);
      const handler = script[nodeName];
      if (!handler) {
        return {
          status: "failed",
          error: `scripted worker has no handler for label "${nodeName}"`,
          usage: SCRIPTED_USAGE,
          estimatedCostUsd: SCRIPTED_COST_USD,
        };
      }

      const callNumber = (callsPerLabel.get(nodeName) ?? 0) + 1;
      callsPerLabel.set(nodeName, callNumber);
      const model = typeof request.config.model === "string" ? request.config.model : undefined;
      const call: ScriptedCall = { nodeName, model, input: request.input };
      calls.push(call);

      // The kill seam (#178): fired before the wait below, so an abort it triggers is already live
      // when this call re-checks its signal — the prompt is cancelled mid-flight, not after settling.
      options.onCall?.({ ...call, callNumber });

      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        // Yield so genuinely-parallel branches are in flight together rather than settling
        // synchronously one after another, which would hide a broken cap.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (request.signal.aborted) return { status: "failed", error: "cancelled" };
        return {
          status: "succeeded",
          output: handler(request, callNumber),
          usage: SCRIPTED_USAGE,
          estimatedCostUsd: SCRIPTED_COST_USD,
        };
      } finally {
        inFlight -= 1;
      }
    },
  };
}
