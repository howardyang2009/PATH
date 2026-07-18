import { describe, expect, it } from "vitest";
import { WorkerSchema } from "../src/worker.js";

describe("WorkerSchema", () => {
  it("validates the engine worker", () => {
    expect(WorkerSchema.safeParse({ type: "engine" }).success).toBe(true);
  });

  it("rejects an engine worker with extra fields", () => {
    expect(WorkerSchema.safeParse({ type: "engine", model: "x" }).success).toBe(false);
  });

  it("validates the llm worker with a required model", () => {
    expect(WorkerSchema.safeParse({ type: "llm", model: "claude-sonnet-5" }).success).toBe(true);
  });

  it("requires model on the llm worker", () => {
    expect(WorkerSchema.safeParse({ type: "llm" }).success).toBe(false);
  });

  it("allows an interpolable model value", () => {
    expect(WorkerSchema.safeParse({ type: "llm", model: "${config.model}" }).success).toBe(true);
  });

  it("rejects a disallowed root in the model interpolation", () => {
    expect(WorkerSchema.safeParse({ type: "llm", model: "${output.model}" }).success).toBe(false);
  });

  it("accepts an options bag for MCP servers / skills / system prompt", () => {
    expect(
      WorkerSchema.safeParse({
        type: "llm",
        model: "claude-sonnet-5",
        options: { systemPrompt: "be terse", mcpServers: {} },
      }).success,
    ).toBe(true);
  });

  it("rejects an unrecognized worker type", () => {
    expect(WorkerSchema.safeParse({ type: "human" }).success).toBe(false);
  });
});
