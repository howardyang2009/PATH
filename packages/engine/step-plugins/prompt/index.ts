import { defineStepPlugin, z } from "@path/engine/plugin";
import type { JsonValue, StepRequest, StepResult } from "@path/engine/plugin";

import { renderPromptMessage } from "./render-prompt-message.js";

/**
 * PATH's built-in `prompt` leaf step type, shipped as a plugin folder under `step-plugins/` and
 * written against the public `@path/engine/plugin` subpath exactly as a third-party plugin is (ADR
 * 0019 sub-10, #336). Its `sdk` worker runs one Agent SDK session per step-run — one `query()` call is
 * one processor, iterated to its terminal `result` message and torn down when `run` returns, so no
 * conversational state leaks between steps (mvp spec §5.5).
 *
 * The folder name *is* the type name. Since the cutover (#337) this folder is the *only* `prompt`
 * implementation — the old `src/llm/agent-sdk-worker.ts` is gone, and the engine dispatches every
 * `prompt` step through the worker discovered here. Only the `sdk` worker ships — the `cli` and
 * `remote` prompt workers named in #309 stay unbuilt.
 */

// The `prompt` type's one author-fixed node field (ADR 0022 sub-1): the instruction text.
const fields = {
  prompt: z.string(),
};

// The `prompt` type's injected, inheritable config (ADR 0022 sub-4): the required `model`, and an
// opaque worker-side `options` bag (MCP servers, skills, system prompt) no engine code interprets.
const config = {
  model: z.string(),
  options: z.record(z.unknown()).optional(),
};

/** The pinned Agent SDK's entry point, imported for its type only so nothing loads the ~250 MB package until a `prompt` step runs (mvp spec §7). */
type SdkQuery = typeof import("@anthropic-ai/claude-agent-sdk").query;

// The SDK's terminal `result` message, narrowed to the fields the run row needs (spec §5.7). Typed
// structurally rather than imported so the worker does not widen to the SDK's full message union.
interface SdkResultMessage {
  type: "result";
  subtype: string;
  result?: string;
  total_cost_usd?: number;
  usage?: unknown;
  errors?: string[];
}

function isResultMessage(message: unknown): message is SdkResultMessage {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "result";
}

// `usage` is stored verbatim on the run row as JSON; the SDK's exact shape is not the engine's
// business, only that it round-trips (spec §5.7).
function asUsage(usage: unknown): JsonValue | undefined {
  return usage === undefined ? undefined : (usage as JsonValue);
}

// Names no step: the engine owns the node's name and prefixes it when it surfaces the result (ADR 0021 sub-6).
function describeSdkFailure(message: SdkResultMessage): string {
  const detail = message.errors?.length ? `: ${message.errors.join("; ")}` : "";
  return `ended with SDK result "${message.subtype}"${detail}`;
}

let queryPromise: Promise<SdkQuery> | undefined;

// Loaded on the first `prompt` step, then reused by every later processor.
function loadQuery(): Promise<SdkQuery> {
  queryPromise ??= import("@anthropic-ai/claude-agent-sdk").then((mod) => mod.query);
  return queryPromise;
}

/**
 * The `sdk` worker. It declares `needsProcessorSlot: true` and holds no semaphore of its own — the
 * engine acquires the processor-concurrency slot and holds it for this call (ADR 0021 sub-5, #331).
 * It `meters`, reporting real `usage` and the SDK's cost estimate on its result.
 *
 * Auth is left to the SDK: it reads the subscription credential when `ANTHROPIC_API_KEY` is unset and
 * the API key when it is set, so neither path needs engine code (mvp spec §7).
 */
async function runSdk(request: StepRequest<typeof fields, typeof config>): Promise<StepResult> {
  const { prompt } = request.fields;
  const { model, options } = request.config;
  const { input, signal } = request;

  if (signal.aborted) return { status: "failed", error: "cancelled" };

  // The SDK takes its own controller; chaining the step's signal onto it is what kills the processor
  // when a sibling parallel branch fails (mvp spec §5.6).
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const query = await loadQuery();
    const session = query({
      prompt: renderPromptMessage(prompt, input),
      options: {
        // Defaults the options bag may override: filesystem settings off so a workflow behaves the
        // same on every machine, and the workflow file's directory as `cwd`.
        cwd: request.cwd,
        settingSources: [],
        ...options,
        // Engine-owned, applied last so the options bag cannot override them: the required `model`,
        // and the abort controller that tears the processor down on a sibling failure (mvp spec §5.6).
        model,
        abortController: controller,
      },
    });

    for await (const message of session) {
      if (!isResultMessage(message)) continue;
      // The abort may lose the race with a result already in flight; either way the engine derives
      // cancelled from the signal, so nothing from an aborted step lands downstream (§5.6).
      const usage = asUsage(message.usage);
      const estimatedCostUsd = message.total_cost_usd;
      if (message.subtype !== "success") {
        return { status: "failed", error: describeSdkFailure(message), usage, estimatedCostUsd };
      }
      // Returning abandons the generator, which tears the session down: the processor does not
      // outlive the step-run (§5.5).
      return { status: "succeeded", output: message.result ?? "", usage, estimatedCostUsd };
    }

    return { status: "failed", error: "the processor ended with no result message" };
  } catch (err) {
    // An abort surfaces as a thrown error from the SDK; the engine relabels it cancelled from the signal.
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export const stepPlugin = defineStepPlugin({
  fields,
  config,
  workers: {
    sdk: { meters: true, needsProcessorSlot: true, run: runSdk },
  },
  defaultWorker: "sdk",
});
