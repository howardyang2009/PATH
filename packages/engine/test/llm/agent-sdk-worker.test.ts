import { describe, expect, it, vi } from "vitest";
import { createAgentSdkWorker, type SdkQuery } from "../../src/llm/agent-sdk-worker.js";

type QueryParams = Parameters<SdkQuery>[0];

const USAGE = { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 15_700 };

function successResult(text: string) {
  return {
    type: "result",
    subtype: "success",
    result: text,
    total_cost_usd: 0.0053,
    usage: USAGE,
    session_id: "session-1",
  };
}

/** A stand-in for the SDK's `query`, recording every call so a test can assert on session shape. */
function fakeQuery(messages: unknown[]): { query: SdkQuery; calls: QueryParams[] } {
  const calls: QueryParams[] = [];
  const query = ((params: QueryParams) => {
    calls.push(params);
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as unknown as SdkQuery;
  return { query, calls };
}

const request = {
  nodeId: "summarize",
  model: "claude-sonnet-5",
  prompt: "Summarize the release.",
  input: { version: "1.2.0" },
  cwd: "/tmp/project",
};

describe("agent-sdk-worker", () => {
  it("sends the rendered prompt message and the step's model to the SDK", async () => {
    const { query, calls } = fakeQuery([successResult("done")]);

    await createAgentSdkWorker({ query }).runPrompt(request);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe('Summarize the release.\n\nInput object:\n{\n  "version": "1.2.0"\n}');
    expect(calls[0]?.options?.model).toBe("claude-sonnet-5");
  });

  it("returns the result text with the run's real token usage and estimated cost (mvp spec §7)", async () => {
    const { query } = fakeQuery([successResult("the summary")]);

    const result = await createAgentSdkWorker({ query }).runPrompt(request);

    expect(result).toEqual({
      status: "succeeded",
      output: "the summary",
      usage: USAGE,
      estimatedCostUsd: 0.0053,
    });
  });

  it("passes the llm worker's options bag through untouched — no engine code speaks MCP (spec §7)", async () => {
    const { query, calls } = fakeQuery([successResult("done")]);
    const options = {
      mcpServers: { docs: { type: "stdio", command: "docs-server" } },
      agents: "all",
      maxTurns: 3,
    };

    await createAgentSdkWorker({ query }).runPrompt({ ...request, options });

    expect(calls[0]?.options).toMatchObject(options);
  });

  it("keeps the worker's declared model authoritative — the options bag cannot override it (spec §7)", async () => {
    const { query, calls } = fakeQuery([successResult("done")]);

    await createAgentSdkWorker({ query }).runPrompt({ ...request, options: { model: "sneaky-override" } });

    expect(calls[0]?.options?.model).toBe("claude-sonnet-5");
  });

  it("isolates the processor from filesystem settings unless the options bag opts back in", async () => {
    const { query, calls } = fakeQuery([successResult("done")]);
    const worker = createAgentSdkWorker({ query });

    await worker.runPrompt(request);
    expect(calls[0]?.options?.settingSources).toEqual([]);
    expect(calls[0]?.options?.cwd).toBe("/tmp/project");

    await worker.runPrompt({ ...request, options: { settingSources: ["project"], cwd: "/elsewhere" } });
    expect(calls[1]?.options?.settingSources).toEqual(["project"]);
    expect(calls[1]?.options?.cwd).toBe("/elsewhere");
  });

  it("spawns a fresh session per step-run — no resumed session, no conversational carry-over", async () => {
    const { query, calls } = fakeQuery([successResult("done")]);
    const worker = createAgentSdkWorker({ query });

    await worker.runPrompt(request);
    await worker.runPrompt({ ...request, prompt: "Second step." });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.options?.resume).toBeUndefined();
      expect(call.options?.continue).toBeUndefined();
      expect(call.options?.forkSession).toBeUndefined();
    }
    // The second call carries only its own prompt — the first step's text never rides along.
    expect(String(calls[1]?.prompt)).not.toContain("Summarize the release.");
  });

  it("fails the step on an SDK error result, still recording the tokens it spent", async () => {
    const { query } = fakeQuery([
      {
        type: "result",
        subtype: "error_max_turns",
        total_cost_usd: 0.02,
        usage: USAGE,
        errors: ["turn limit reached"],
      },
    ]);

    const result = await createAgentSdkWorker({ query }).runPrompt(request);

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ usage: USAGE, estimatedCostUsd: 0.02 });
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.error).toContain("summarize");
    expect(result.error).toContain("error_max_turns");
  });

  it("fails the step when the session ends without ever producing a result", async () => {
    const { query } = fakeQuery([{ type: "system", subtype: "init" }]);

    const result = await createAgentSdkWorker({ query }).runPrompt(request);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.error).toContain("no result");
  });

  it("fails the step when the SDK itself throws (a torn-down or unauthenticated processor)", async () => {
    const query = (() => {
      return (async function* () {
        yield { type: "system", subtype: "init" };
        throw new Error("credential not found");
      })();
    }) as unknown as SdkQuery;

    const result = await createAgentSdkWorker({ query }).runPrompt(request);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.error).toContain("credential not found");
  });

  it("reports cancelled — not failed — when a failing parallel sibling aborts the step (spec §5.6)", async () => {
    const controller = new AbortController();
    const query = (() => {
      return (async function* () {
        yield { type: "system", subtype: "init" };
        controller.abort();
        throw new Error("aborted");
      })();
    }) as unknown as SdkQuery;

    const result = await createAgentSdkWorker({ query }).runPrompt({ ...request, signal: controller.signal });

    expect(result).toEqual({ status: "cancelled" });
  });

  it("never starts a processor for an already-aborted step", async () => {
    const { query, calls } = fakeQuery([successResult("done")]);
    const controller = new AbortController();
    controller.abort();

    const result = await createAgentSdkWorker({ query }).runPrompt({ ...request, signal: controller.signal });

    expect(result).toEqual({ status: "cancelled" });
    expect(calls).toEqual([]);
  });

  it("gives the SDK an abort controller so an in-flight step tears its processor down", async () => {
    const calls: QueryParams[] = [];
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const query = ((params: QueryParams) => {
      calls.push(params);
      return (async function* () {
        yield { type: "system", subtype: "init" };
        await sessionGate; // hold the processor open so the abort lands mid-session
        yield successResult("done");
      })();
    }) as unknown as SdkQuery;

    const controller = new AbortController();
    const pending = createAgentSdkWorker({ query }).runPrompt({ ...request, signal: controller.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const sdkController = calls[0]?.options?.abortController;
    expect(sdkController).toBeInstanceOf(AbortController);
    expect(sdkController?.signal.aborted).toBe(false);

    controller.abort();
    expect(sdkController?.signal.aborted).toBe(true);

    releaseSession();
    expect(await pending).toEqual({ status: "cancelled" });
  });

  it("loads the pinned SDK lazily, so a binary-only run never pays for it", async () => {
    const load = vi.fn(async () => fakeQuery([successResult("done")]).query);
    const worker = createAgentSdkWorker({ load });

    expect(load).not.toHaveBeenCalled();
    await worker.runPrompt(request);
    await worker.runPrompt(request);
    expect(load).toHaveBeenCalledTimes(1); // loaded once, then reused across processors
  });
});
