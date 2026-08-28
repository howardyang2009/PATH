import { describe, expect, it } from "vitest";
import { z as zFromZod } from "zod";

import { defineStepPlugin, resolveAgainstWorkflowDir, z } from "@path/engine/plugin";
import { stepPlugin } from "./fixtures/plugin-contract/index.js";

// The subpath is the one public surface a plugin compiles against (#333, ADR 0019 sub-5). These
// assertions cover what a type can't: that the subpath resolves at run time and hands out one zod.

describe("@path/engine/plugin", () => {
  it("re-exports the engine's own single zod instance", () => {
    // ADR 0019 sub-5: two zod instances break the schema factory's `instanceof` checks, so the subpath
    // must hand out the very object `zod` exports, not a copy.
    expect(z).toBe(zFromZod);
  });

  it("defineStepPlugin is an identity helper", () => {
    const plugin = { fields: {}, config: {}, workers: {}, defaultWorker: "x" };
    expect(defineStepPlugin(plugin)).toBe(plugin);
  });

  describe("resolveAgainstWorkflowDir", () => {
    it("resolves a relative path against the workflow dir", () => {
      expect(resolveAgainstWorkflowDir("/wf", "./out")).toBe("/wf/out");
    });

    it("yields the workflow dir itself for '.'", () => {
      expect(resolveAgainstWorkflowDir("/wf", ".")).toBe("/wf");
    });

    it("lets an absolute path win", () => {
      expect(resolveAgainstWorkflowDir("/wf", "/elsewhere")).toBe("/elsewhere");
    });
  });
});

describe("plugin-contract fixture", () => {
  it("declares its default worker and fragments", () => {
    expect(stepPlugin.defaultWorker).toBe("fetch");
    expect(Object.keys(stepPlugin.fields)).toEqual(["endpoint", "method"]);
    expect(Object.keys(stepPlugin.config)).toEqual(["token", "retries"]);
    expect(stepPlugin.workers.fetch?.needsProcessorSlot).toBe(false);
  });

  it("runs to a succeeded result", async () => {
    const result = await stepPlugin.workers.fetch!.run({
      fields: { endpoint: "https://example.test", method: "GET" },
      input: { q: 1 },
      config: { token: "t", retries: undefined },
      cwd: "/wf",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.output).toMatchObject({ endpoint: "https://example.test", method: "GET", where: "/wf/out" });
    }
  });

  it("reports failed when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await stepPlugin.workers.fetch!.run({
      fields: { endpoint: "https://example.test", method: "POST" },
      input: null,
      config: { token: "t", retries: 2 },
      cwd: "/wf",
      signal: controller.signal,
    });
    expect(result.status).toBe("failed");
  });
});
