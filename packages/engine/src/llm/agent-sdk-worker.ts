import type { JsonValue } from "@path/schema";
import type { LlmWorker, PromptRequest, PromptResult } from "./llm-worker.js";
import { renderPromptMessage } from "./render-prompt-message.js";

/**
 * The pinned Agent SDK's entry point (mvp spec §7 — the spike ran 0.3.214). Taken as a type-only
 * import so nothing loads the ~250 MB package until a workflow actually has a `prompt` step.
 */
export type SdkQuery = typeof import("@anthropic-ai/claude-agent-sdk").query;

export interface AgentSdkWorkerOptions {
  /** Injected `query` — tests drive the worker without spawning a real processor. */
  query?: SdkQuery;
  /** How the pinned SDK is loaded when no `query` is injected; overridable for tests. */
  load?: () => Promise<SdkQuery>;
}

// The SDK's terminal `result` message, narrowed to the fields the run row needs (spec §5.7).
// Typed structurally rather than imported so the seam does not widen to the SDK's full message union.
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
function asUsage(usage: unknown): JsonValue | null {
  return usage === undefined ? null : (usage as JsonValue);
}

function describeError(message: SdkResultMessage, nodeId: string): string {
  const detail = message.errors?.length ? `: ${message.errors.join("; ")}` : "";
  return `prompt step "${nodeId}" ended with SDK result "${message.subtype}"${detail}`;
}

/**
 * The MVP LLM worker: one Agent SDK session per `prompt` step-run (mvp spec §5.5, §7). One
 * `query()` call is one processor — started here, iterated to its terminal `result` message, and
 * torn down when this function returns. Nothing is carried between calls, so no conversational
 * state leaks from one step to the next.
 *
 * Auth is left entirely to the SDK: it reads the macOS-keychain subscription credential when
 * `ANTHROPIC_API_KEY` is unset and the API key when it is set, so neither path needs engine code
 * (and no headless-CLI fallback is built — §7).
 */
export function createAgentSdkWorker(options: AgentSdkWorkerOptions = {}): LlmWorker {
  const load = options.load ?? (async () => (await import("@anthropic-ai/claude-agent-sdk")).query);
  let queryPromise: Promise<SdkQuery> | undefined;

  function getQuery(): Promise<SdkQuery> {
    if (options.query) return Promise.resolve(options.query);
    queryPromise ??= load(); // loaded on the first prompt step, then reused by every later processor
    return queryPromise;
  }

  return {
    async runPrompt(request: PromptRequest): Promise<PromptResult> {
      if (request.signal?.aborted) return { status: "cancelled" };

      // The SDK takes its own controller; chaining the step's signal onto it is what actually
      // kills the processor when a sibling parallel branch fails (mvp spec §5.6).
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const query = await getQuery();
        const session = query({
          prompt: renderPromptMessage(request.prompt, request.input),
          options: {
            // Defaults the options bag may override: filesystem settings are off so a workflow
            // behaves the same on every machine, but a workflow that wants CLAUDE.md or project
            // settings opts back in; likewise `cwd`.
            cwd: request.cwd,
            settingSources: [],
            ...request.options,
            // Engine-owned, applied last so the options bag cannot override them: `model` is the
            // worker's own required field (format doc §7), and the abort controller is what tears
            // the processor down on a sibling failure (mvp spec §5.6).
            model: request.model,
            abortController: controller,
          },
        });

        for await (const message of session) {
          if (!isResultMessage(message)) continue;
          // The abort may lose the race with a result the processor already had in flight. An
          // aborted step is cancelled either way: nothing from it may land downstream (§5.6).
          if (request.signal?.aborted) return { status: "cancelled" };
          const usage = asUsage(message.usage);
          const estimatedCostUsd = message.total_cost_usd ?? null;
          if (message.subtype !== "success") {
            return { status: "failed", error: describeError(message, request.nodeId), usage, estimatedCostUsd };
          }
          // Returning here abandons the generator, which tears the session down: the processor
          // does not outlive the step-run (§5.5).
          return { status: "succeeded", output: message.result ?? "", usage, estimatedCostUsd };
        }

        return {
          status: "failed",
          error: `prompt step "${request.nodeId}": the processor ended with no result message`,
          usage: null,
          estimatedCostUsd: null,
        };
      } catch (err) {
        // An abort surfaces as a thrown error from the SDK; that is a cancellation, not a step
        // failure, so no publish from it lands (mvp spec §5.6).
        if (request.signal?.aborted) return { status: "cancelled" };
        return {
          status: "failed",
          error: `prompt step "${request.nodeId}": ${err instanceof Error ? err.message : String(err)}`,
          usage: null,
          estimatedCostUsd: null,
        };
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
