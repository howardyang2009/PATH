import type { JsonValue, StepRequest, StepResult } from "@path/engine/plugin";
import type { PromptConfig, PromptFields } from "./index.js";
import { renderPromptMessage } from "./render-prompt-message.js";

/**
 * The `prompt` type's `deepseek` worker: one OpenAI-compatible Chat Completions request per step-run
 * (https://api-docs.deepseek.com/api/create-chat-completion), selected by `"worker": "deepseek"` on the
 * step.
 *
 * DeepSeek also exposes an Anthropic-compatible endpoint, which would have let this worker reuse the
 * `anthropic` worker's Agent SDK transport verbatim. It does not, deliberately: the Agent SDK runs a whole
 * agent harness (tools, filesystem access, MCP servers, a bundled Claude Code binary) around the
 * model, and pointing that harness at a non-Anthropic endpoint makes the step's actual behavior depend
 * on how complete the third party's emulation is. A direct Chat Completions call sends exactly the
 * instruction the author wrote and takes exactly the text back, so this worker's behavior is legible
 * from its own file.
 *
 * The credential is read from `config.DEEPSEEK_API_KEY` first and `process.env.DEEPSEEK_API_KEY`
 * second (ADR 0045): config first because an operator launching a discovered workflow can supply the
 * key there without reaching the server's environment, and because a `$secret`-wrapped config value
 * is the one the masker collects — `process.env` is invisible to it. The environment stays as the
 * fallback a deployment-level key already used, so nothing that works today stops working. The
 * endpoint is environment only — `DEEPSEEK_BASE_URL` when a deployment proxies the API — because a
 * gateway address is deployment topology, not a per-run credential.
 *
 * The worker takes the same `fields` (`prompt`) and `config` (`model`, `options`) as `anthropic` — it is the
 * same step type, asked the same question — so a step switches provider by naming this worker and
 * changing nothing else.
 */

/** The API root every request path hangs off; `DEEPSEEK_BASE_URL` overrides it for a gateway or a test double. */
const DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * The DeepSeek models this worker knows the price of, per **million** tokens in USD, at the **peak**
 * rate (https://api-docs.deepseek.com/quick_start/pricing). Used only to turn the vendor's token counts
 * into the `estimatedCostUsd` the run row carries; never to gate or route a request.
 *
 * Peak, not off-peak: off-peak (all hours outside 01:00–04:00 and 06:00–10:00 UTC on weekdays) is half
 * these rates, so this is the ceiling of what the step could have cost. A cost estimate that can only
 * overstate is the honest direction for a ceiling to err.
 */
const PEAK_USD_PER_MILLION_TOKENS: Record<
  string,
  { cacheHitInput: number; cacheMissInput: number; output: number }
> = {
  "deepseek-flash": { cacheHitInput: 0.006, cacheMissInput: 0.3, output: 1.2 },
  "deepseek-v4-pro": { cacheHitInput: 0.044, cacheMissInput: 1.32, output: 3.96 },
};

/**
 * The Claude model names DeepSeek's own docs map onto its models. They are here so a step that switched
 * to this worker but left `model` inherited from a `config.model` naming a Claude model answers a
 * DeepSeek request instead of failing on the model name. The mapping is reported as a diagnostic
 * whenever it fires, because a silent substitution of the model behind a step is exactly the kind of
 * fact a run's audit should keep.
 */
function mapForeignModel(model: string): string | undefined {
  const name = model.toLowerCase();
  if (name.startsWith("claude-opus")) return "deepseek-v4-pro";
  if (name.startsWith("claude-haiku") || name.startsWith("claude-sonnet")) return "deepseek-flash";
  return undefined;
}

/** The request body for one call. Keys of the author's `options` bag this transport cannot express are ignored. */
function buildRequestBody(request: StepRequest<PromptFields, PromptConfig>, model: string): string {
  const { prompt } = request.fields;
  const options = request.config.options ?? {};
  const system = options.systemPrompt;
  const messages: unknown[] = [];
  // `options.systemPrompt` is the one Agent SDK key with a direct meaning here; it is accepted as a
  // plain string only, since the SDK's structured variants (preset/paths) are harness concepts.
  if (typeof system === "string" && system !== "")
    messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: renderPromptMessage(prompt, request.input) });

  const body: Record<string, unknown> = { model, messages, stream: false };
  // Passed through when an author set them; DeepSeek's own defaults apply otherwise. `max_tokens` must
  // be an integer to be accepted, so a non-number is dropped rather than sent to fail remotely.
  if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;
  if (typeof options.temperature === "number") body.temperature = options.temperature;
  // DeepSeek-specific and passed through verbatim: `{ type: "disabled" }` turns thinking off, which is
  // worth exposing because thinking mode changes both latency and what the model emits.
  if (options.thinking !== undefined) body.thinking = options.thinking;
  return JSON.stringify(body);
}

/** The vendor's own counter block, stored on the run row verbatim (spec §5.7). Undefined when the response carries none. */
function asUsage(usage: unknown): JsonValue | undefined {
  return usage === undefined || usage === null ? undefined : (usage as JsonValue);
}

/**
 * The peak-rate cost estimate for one response, from DeepSeek's cache-aware counters. Returns undefined
 * for a model this worker holds no price for, or a response whose usage block is missing — an absent
 * estimate is honest; a zero would claim the step was free.
 */
function estimateCostUsd(model: string, usage: JsonValue | undefined): number | undefined {
  const price = PEAK_USD_PER_MILLION_TOKENS[model];
  if (price === undefined || typeof usage !== "object" || usage === null) return undefined;
  const counters = usage as Record<string, unknown>;
  const number = (key: string): number =>
    typeof counters[key] === "number" ? (counters[key] as number) : 0;
  const cost =
    (number("prompt_cache_hit_tokens") * price.cacheHitInput +
      number("prompt_cache_miss_tokens") * price.cacheMissInput +
      number("completion_tokens") * price.output) /
    1_000_000;
  return cost;
}

/** The first choice's text, or undefined when the response carries no choice at all. */
function firstChoiceText(payload: unknown): { text: string; finishReason?: string } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const choice = choices[0] as
    | { message?: { content?: unknown }; finish_reason?: unknown }
    | undefined;
  const content = choice?.message?.content;
  return {
    text: typeof content === "string" ? content : "",
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}

/** Keeps a provider's error text bounded — an HTML error page from a proxy is not worth a whole run row. */
function truncate(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * The `deepseek` worker. Like `anthropic`, it declares `needsProcessorSlot: true` and `meters: true` — the
 * capabilities belong to the worker, and both make one metered processor call per step-run (ADR 0021
 * sub-5). `stderr` carries diagnostics, the one sanctioned channel (ADR 0020 sub-4): a model-name
 * mapping, and a body the API rejected.
 */
export async function runDeepseekWorker(
  request: StepRequest<PromptFields, PromptConfig>,
): Promise<StepResult> {
  const { signal } = request;
  const { model: requestedModel } = request.config;

  if (signal.aborted) return { status: "failed", error: "cancelled" };

  // Config beats the environment; an empty string counts as unset in both, so a `config.DEEPSEEK_API_KEY`
  // that resolved to "" (an `$env` naming an empty variable, say) falls through to the environment
  // rather than sending an empty bearer token.
  const configKey = request.config.DEEPSEEK_API_KEY;
  const apiKey =
    configKey !== undefined && configKey !== "" ? configKey : process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    // No request is attempted without a credential, so this is the one failure that spends nothing:
    // it names both doors to set rather than surfacing the API's 401 as the author's problem.
    return {
      status: "failed",
      error:
        "DEEPSEEK_API_KEY is not set: give it as config.DEEPSEEK_API_KEY or in the engine's environment",
    };
  }

  const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const mapped = mapForeignModel(requestedModel);
  const model = mapped ?? requestedModel;
  const mappedNote =
    mapped === undefined ? undefined : `model "${requestedModel}" mapped to DeepSeek "${mapped}"`;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: buildRequestBody(request, model),
      signal,
    });

    const text = await response.text();
    // A non-2xx is a failure whether or not the body parses: the provider's own error text is the
    // most useful thing to keep, so it rides `stderr` while the status names the failure.
    if (!response.ok) {
      return {
        status: "failed",
        error: `DeepSeek API returned HTTP ${response.status}`,
        stderr: truncate(text),
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return {
        status: "failed",
        error: "DeepSeek API returned a body that is not JSON",
        stderr: truncate(text),
      };
    }

    const choice = firstChoiceText(payload);
    if (choice === undefined) {
      return {
        status: "failed",
        error: "DeepSeek API returned no completion choice",
        stderr: truncate(text),
      };
    }

    const usage = asUsage((payload as { usage?: unknown }).usage);
    // A `length` finish means the answer was cut off at `max_tokens`. It is not an error — the text is
    // real model output and a downstream `parse: "json"` step is the right place to reject a truncated
    // document — but it is worth a diagnostic, because a silently clipped answer is otherwise invisible.
    const truncation =
      choice.finishReason === "length" ? "response was cut off at max_tokens" : undefined;
    return {
      status: "succeeded",
      output: choice.text,
      usage,
      estimatedCostUsd: estimateCostUsd(model, usage),
      stderr:
        [mappedNote, truncation].filter((line): line is string => line !== undefined).join("; ") ||
        undefined,
    };
  } catch (err) {
    // An abort surfaces here as the fetch rejecting; the engine relabels it cancelled from the signal.
    return {
      status: "failed",
      error: `DeepSeek request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
