import { describe, expect, it } from "vitest";
import { CompletionRegistry } from "../src/completion-registry.js";

describe("CompletionRegistry", () => {
  it("resolves a waiting step when complete is called", async () => {
    const registry = new CompletionRegistry();
    const promise = registry.wait("step-1");

    expect(registry.has("step-1")).toBe(true);
    expect(registry.size).toBe(1);

    expect(registry.complete("step-1", { output: { ok: true } })).toBe(true);
    const result = await promise;
    expect(result).toEqual({ output: { ok: true } });
    expect(registry.size).toBe(0);
  });

  it("returns false when completing a step that is not waiting", () => {
    const registry = new CompletionRegistry();
    expect(registry.complete("nonexistent", { output: null })).toBe(false);
  });

  it("supports multiple concurrent awaiting steps", async () => {
    const registry = new CompletionRegistry();
    const p1 = registry.wait("step-1");
    const p2 = registry.wait("step-2");

    expect(registry.size).toBe(2);

    registry.complete("step-2", { output: "second" });
    registry.complete("step-1", { output: "first" });

    expect(await p1).toEqual({ output: "first" });
    expect(await p2).toEqual({ output: "second" });
    expect(registry.size).toBe(0);
  });

  it("rejects the promise when the signal aborts", async () => {
    const registry = new CompletionRegistry();
    const controller = new AbortController();
    const promise = registry.wait("step-1", controller.signal);

    controller.abort();

    await expect(promise).rejects.toThrow("cancelled");
    expect(registry.has("step-1")).toBe(false);
  });

  it("rejects immediately when the signal is already aborted before wait", async () => {
    const registry = new CompletionRegistry();
    const controller = new AbortController();
    controller.abort();

    const promise = registry.wait("step-1", controller.signal);

    await expect(promise).rejects.toThrow("cancelled");
    expect(registry.has("step-1")).toBe(false);
  });

  it("ignores the signal abort after completion", async () => {
    const registry = new CompletionRegistry();
    const controller = new AbortController();
    const promise = registry.wait("step-1", controller.signal);

    registry.complete("step-1", { output: 42 });
    controller.abort();

    const result = await promise;
    expect(result).toEqual({ output: 42 });
  });
});
