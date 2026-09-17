import { beforeEach, describe, expect, it, vi } from "vitest";

// The `sdk` worker loads the Agent SDK through a dynamic `import("@anthropic-ai/claude-agent-sdk")`;
// mocking the specifier lets each case script the single terminal `result` message the worker reads.
const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query }));

import { stepPlugin } from "../../../step-plugins/prompt/index.js";

const sdk = stepPlugin.workers.sdk;
if (!sdk) throw new Error("prompt plugin is missing its sdk worker");
const run = sdk.run;

// One async-iterable session yielding the messages the SDK would stream; the worker only reads the
// terminal `result`, so a single result message is enough.
function session(...messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
  };
}

function request(): Parameters<typeof run>[0] {
  return {
    fields: { prompt: "Judge the draft." },
    config: { model: "claude-sonnet-5" },
    input: "a draft",
    cwd: "/tmp",
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof run>[0];
}

describe("sdk prompt worker", () => {
  beforeEach(() => query.mockReset());

  it("returns the result text on a clean success", async () => {
    query.mockReturnValue(session({ type: "result", subtype: "success", is_error: false, result: "the verdict" }));

    const result = await run(request());

    expect(result).toMatchObject({ status: "succeeded", output: "the verdict" });
  });

  it("fails an is_error result even under a success subtype, and surfaces its text", async () => {
    // The exact shape the OAuth-expiry failure arrives in: a success subtype, is_error set, and the
    // error message in `result` — which used to be stored as succeeded output and fed downstream.
    query.mockReturnValue(
      session({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Failed to authenticate: OAuth session expired and could not be refreshed",
      }),
    );

    const result = await run(request());

    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("output");
    if (result.status !== "failed") throw new Error("expected a failed result");
    expect(result.error).toContain("Failed to authenticate: OAuth session expired");
  });

  it("fails an error subtype and joins its errors", async () => {
    query.mockReturnValue(
      session({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom", "again"] }),
    );

    const result = await run(request());

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected a failed result");
    expect(result.error).toContain("boom; again");
  });
});
