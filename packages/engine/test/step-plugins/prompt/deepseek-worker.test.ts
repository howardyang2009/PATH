import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "@path/engine/plugin";
import type { StepRequest } from "../../../src/plugin/seam.js";
import { runDeepseekWorker } from "../../../step-plugins/prompt/deepseek-worker.js";
import type { PromptFields, PromptConfig } from "../../../step-plugins/prompt/index.js";

// The `deepseek` worker, tested at its own boundary: a stubbed `fetch` stands in for the API, so every
// case asserts what PATH *sends* and how it reads what comes back. Nothing here touches the network.
//
// The worker is reached exactly as the engine reaches it — the descriptor's `run` — so this file also
// pins the fact that `deepseek` is an ordinary PATH worker, not a special mode of `anthropic`.

/** What the worker handed to `fetch`, as recorded by the stub's first call. */
interface RecordedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function stubFetch(response: { ok?: boolean; status?: number; body: string }): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => response.body,
    };
  });
  return { calls };
}

/** A minimal successful chat-completion body, shaped as the API documents it. */
function completion(content: string, usage?: unknown, finishReason = "stop"): string {
  return JSON.stringify({
    id: "chat-1",
    object: "chat.completion",
    model: "deepseek-flash",
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
    usage,
  });
}

/** The worker's request, typed by the plugin's own fragments — the same shape the engine builds. */
function request(overrides: { prompt?: string; model?: string; options?: Record<string, unknown>; input?: JsonValue; signal?: AbortSignal } = {}): StepRequest<PromptFields, PromptConfig> {
  return {
    fields: { prompt: overrides.prompt ?? "Judge the draft." },
    config: { model: overrides.model ?? "deepseek-flash", options: overrides.options },
    input: overrides.input ?? "a draft",
    cwd: "/tmp",
    signal: overrides.signal ?? new AbortController().signal,
  };
}

let savedKey: string | undefined;
let savedBase: string | undefined;

beforeEach(() => {
  savedKey = process.env.DEEPSEEK_API_KEY;
  savedBase = process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = savedKey;
  if (savedBase === undefined) delete process.env.DEEPSEEK_BASE_URL;
  else process.env.DEEPSEEK_BASE_URL = savedBase;
});

describe("the deepseek worker's request", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  it("posts the message to the chat-completions endpoint with a bearer credential", async () => {
    const { calls } = stubFetch({ body: completion("answer") });

    await runDeepseekWorker(request());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer test-key" });
  });

  it("sends the rendered message as a single user turn, and the model verbatim", async () => {
    const { calls } = stubFetch({ body: completion("answer") });

    await runDeepseekWorker(request({ prompt: "Judge.", input: {}, model: "deepseek-v4-pro" }));

    expect(calls[0]!.body).toMatchObject({
      model: "deepseek-v4-pro",
      stream: false,
      messages: [{ role: "user", content: "Judge.\n\nInput object:\n{}" }],
    });
  });

  it("honors a base-url override, for a gateway or a local double", async () => {
    process.env.DEEPSEEK_BASE_URL = "https://gateway.internal/deepseek/";
    const { calls } = stubFetch({ body: completion("answer") });

    await runDeepseekWorker(request());

    // The trailing slash is normalized, so the path never doubles up.
    expect(calls[0]!.url).toBe("https://gateway.internal/deepseek/chat/completions");
  });

  it("reads only the options its transport can honor and ignores the Agent SDK's keys", async () => {
    const { calls } = stubFetch({ body: completion("answer") });

    await runDeepseekWorker(
      request({ input: "", options: { systemPrompt: "You are terse.", maxTokens: 512, temperature: 0, thinking: { type: "disabled" }, mcpServers: { x: {} }, skills: ["a"] } }),
    );

    expect(calls[0]!.body).toMatchObject({
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Judge the draft.\n\nInput object:\n" },
      ],
      max_tokens: 512,
      temperature: 0,
      thinking: { type: "disabled" },
    });
    // The SDK-only keys never reach the wire.
    expect(calls[0]!.body).not.toHaveProperty("mcpServers");
    expect(calls[0]!.body).not.toHaveProperty("skills");
  });

  it("omits a non-string system prompt rather than sending a shape the API would reject", async () => {
    const { calls } = stubFetch({ body: completion("answer") });

    await runDeepseekWorker(request({ input: "", options: { systemPrompt: { type: "preset", preset: "claude_code" } } }));

    expect(calls[0]!.body.messages).toEqual([{ role: "user", content: "Judge the draft.\n\nInput object:\n" }]);
  });

  it("drops a non-numeric max_tokens or temperature instead of failing remotely", async () => {
    const { calls } = stubFetch({ body: completion("answer") });

    await runDeepseekWorker(request({ options: { maxTokens: "512", temperature: "hot" } }));

    expect(calls[0]!.body).not.toHaveProperty("max_tokens");
    expect(calls[0]!.body).not.toHaveProperty("temperature");
  });
});

describe("the deepseek worker's response handling", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  it("returns the choice's text with the vendor's usage block verbatim", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };
    stubFetch({ body: completion("the verdict", usage) });

    const result = await runDeepseekWorker(request());

    expect(result).toMatchObject({ status: "succeeded", output: "the verdict", usage });
  });

  it("estimates cost from the cache-aware counters at the peak rate", async () => {
    // deepseek-flash peak: 0.3/1M cache-miss input, 1.2/1M output.
    stubFetch({
      body: completion("answer", { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1_000_000, completion_tokens: 1_000_000 }),
    });

    const result = await runDeepseekWorker(request());

    expect(result.status === "succeeded" && result.estimatedCostUsd).toBeCloseTo(1.5, 10);
  });

  it("prices a cache hit at the cheaper input rate", async () => {
    // 1M cache-hit input is 0.006, so a run of hits must not be billed at the miss rate.
    stubFetch({
      body: completion("answer", { prompt_cache_hit_tokens: 1_000_000, prompt_cache_miss_tokens: 0, completion_tokens: 0 }),
    });

    const result = await runDeepseekWorker(request());

    expect(result.status === "succeeded" && result.estimatedCostUsd).toBeCloseTo(0.006, 10);
  });

  it("omits a cost estimate for a model it holds no price for, rather than claiming zero", async () => {
    stubFetch({ body: completion("answer", { prompt_cache_miss_tokens: 1_000_000, completion_tokens: 1_000_000 }) });

    const result = await runDeepseekWorker(request({ model: "some-other-model" }));

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error("expected a succeeded result");
    expect(result.estimatedCostUsd).toBeUndefined();
  });

  it("maps a Claude model name onto DeepSeek and says so in stderr", async () => {
    const { calls } = stubFetch({ body: completion("answer") });

    const result = await runDeepseekWorker(request({ model: "claude-sonnet-5" }));

    expect(calls[0]!.body.model).toBe("deepseek-flash");
    if (result.status !== "succeeded") throw new Error("expected a succeeded result");
    expect(result.stderr).toBe('model "claude-sonnet-5" mapped to DeepSeek "deepseek-flash"');
  });

  it("maps an opus name onto the pro model", async () => {
    const { calls } = stubFetch({ body: completion("answer") });

    await runDeepseekWorker(request({ model: "claude-opus-5" }));

    expect(calls[0]!.body.model).toBe("deepseek-v4-pro");
  });

  it("keeps a native DeepSeek model name and reports no mapping", async () => {
    const { calls } = stubFetch({ body: completion("answer") });

    const result = await runDeepseekWorker(request({ model: "deepseek-v4-pro" }));

    expect(calls[0]!.body.model).toBe("deepseek-v4-pro");
    if (result.status !== "succeeded") throw new Error("expected a succeeded result");
    expect(result.stderr).toBeUndefined();
  });

  it("flags a response cut off at max_tokens without failing the step", async () => {
    stubFetch({ body: completion("partial", undefined, "length") });

    const result = await runDeepseekWorker(request());

    expect(result).toMatchObject({ status: "succeeded", output: "partial", stderr: "response was cut off at max_tokens" });
  });

  it("fails a non-2xx with the status in the error and the provider's body as stderr", async () => {
    stubFetch({ ok: false, status: 402, body: '{"error":{"message":"Insufficient Balance"}}' });

    const result = await runDeepseekWorker(request());

    expect(result).toMatchObject({ status: "failed", error: "DeepSeek API returned HTTP 402" });
    if (result.status !== "failed") throw new Error("expected a failed result");
    expect(result.stderr).toContain("Insufficient Balance");
  });

  it("fails a 200 body that is not JSON", async () => {
    stubFetch({ body: "<html>proxy error</html>" });

    const result = await runDeepseekWorker(request());

    expect(result).toMatchObject({ status: "failed", error: "DeepSeek API returned a body that is not JSON" });
  });

  it("fails a body carrying no choice", async () => {
    stubFetch({ body: JSON.stringify({ id: "x", choices: [] }) });

    const result = await runDeepseekWorker(request());

    expect(result).toMatchObject({ status: "failed", error: "DeepSeek API returned no completion choice" });
  });

  it("reports a transport failure rather than throwing out of the worker", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("getaddrinfo ENOTFOUND api.deepseek.com");
    });

    const result = await runDeepseekWorker(request());

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected a failed result");
    expect(result.error).toContain("getaddrinfo ENOTFOUND");
  });
});

describe("the deepseek worker's credential handling", () => {
  it("fails with the variable's name when no key is configured, and attempts no request", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runDeepseekWorker(request());

    expect(result).toMatchObject({ status: "failed", error: "DEEPSEEK_API_KEY is not set in the engine's environment" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats an empty key as unset", async () => {
    process.env.DEEPSEEK_API_KEY = "";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runDeepseekWorker(request());

    expect(result.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not attempt a request on an already-aborted step", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const controller = new AbortController();
    controller.abort();

    const result = await runDeepseekWorker(request({ signal: controller.signal }));

    expect(result).toMatchObject({ status: "failed", error: "cancelled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
