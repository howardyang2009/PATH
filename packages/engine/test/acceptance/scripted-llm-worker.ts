import type { JsonValue } from "@path/schema";
import type { LlmWorker, PromptRequest, PromptResult } from "../../src/llm/llm-worker.js";

/**
 * What one scripted prompt step returns. A handler receives the request and the 1-based count of
 * how many times *this node* has been asked so far, so a script can answer differently on each
 * pass — the never-passing judge of mvp spec §11's second failure path is exactly that.
 */
export type ScriptedHandler = (request: PromptRequest, callNumber: number) => string;

export interface ScriptedCall {
  nodeId: string;
  model: string;
  input: JsonValue;
}

export interface ScriptedLlmWorker extends LlmWorker {
  /** Every prompt request the engine made, in settle order. */
  readonly calls: readonly ScriptedCall[];
  /** The high-water mark of concurrently in-flight processors — the fan-out cap under test (§11.4). */
  readonly maxConcurrent: number;
}

/** Fixed per-call spend, so `usage`/`estimated_cost_usd` assertions have a known expected value. */
export const SCRIPTED_USAGE: JsonValue = { input_tokens: 1200, output_tokens: 340 };
export const SCRIPTED_COST_USD = 0.0042;

/**
 * A stand-in for the Agent SDK worker (mvp spec §7) that answers from a per-node script instead of
 * spawning a processor. It is the *only* thing faked in the acceptance run: the engine, the real
 * workflow files, git, persistence and logging are all real. Faking it is what makes the pipeline
 * deterministic and free to run in CI — a live processor is neither.
 *
 * Each call holds its slot for a turn of the event loop before resolving, so two branches that the
 * engine genuinely runs at once overlap here and `maxConcurrent` can observe it.
 */
export function createScriptedLlmWorker(script: Record<string, ScriptedHandler>): ScriptedLlmWorker {
  const calls: ScriptedCall[] = [];
  const callsPerNode = new Map<string, number>();
  let inFlight = 0;
  let maxConcurrent = 0;

  return {
    get calls() {
      return calls;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    async runPrompt(request: PromptRequest): Promise<PromptResult> {
      if (request.signal?.aborted) return { status: "cancelled" };

      const handler = script[request.nodeId];
      if (!handler) {
        return {
          status: "failed",
          error: `scripted worker has no handler for prompt node "${request.nodeId}"`,
          usage: SCRIPTED_USAGE,
          estimatedCostUsd: SCRIPTED_COST_USD,
        };
      }

      const callNumber = (callsPerNode.get(request.nodeId) ?? 0) + 1;
      callsPerNode.set(request.nodeId, callNumber);
      calls.push({ nodeId: request.nodeId, model: request.model, input: request.input });

      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        // Yield so genuinely-parallel branches are in flight together rather than settling
        // synchronously one after another, which would hide a broken cap.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (request.signal?.aborted) return { status: "cancelled" };
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
