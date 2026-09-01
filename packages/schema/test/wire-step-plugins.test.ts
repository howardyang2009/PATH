import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeField, toWireStepPlugins } from "../src/wire-step-plugins.js";
import type { StepPluginRegistry } from "../src/nodes.js";
import { builtinRegistry } from "./builtin-registry.js";

const doNotRun = () => Promise.reject(new Error("run must not be called"));

describe("describeField", () => {
  it("projects a plain string field", () => {
    expect(describeField(z.string())).toEqual({ type: "string", optional: false });
  });

  it("marks an `.optional()` field optional and unwraps to the inner kind", () => {
    expect(describeField(z.string().optional())).toEqual({ type: "string", optional: true });
  });

  it("keeps the element kind of an array, and its own optionality", () => {
    expect(describeField(z.array(z.string()).optional())).toEqual({
      type: "array",
      optional: true,
      element: { type: "string", optional: false },
    });
  });

  it("keeps the value kind of a record", () => {
    expect(describeField(z.record(z.unknown()))).toEqual({
      type: "record",
      optional: false,
      values: { type: "unknown", optional: false },
    });
  });

  it("nullable and default decorate but do not make a key omittable", () => {
    expect(describeField(z.number().nullable())).toEqual({ type: "number", optional: false });
    expect(describeField(z.boolean().default(true))).toEqual({ type: "boolean", optional: false });
  });
});

describe("toWireStepPlugins", () => {
  it("emits one snake_case entry per registered type, sorted by name", () => {
    const res = toWireStepPlugins(builtinRegistry);
    // `binary` sorts before `prompt` regardless of the registry's key order.
    expect(res.step_plugins.map((p) => p.name)).toEqual(["binary", "prompt"]);
  });

  it("matches each built-in's registration: fields, workers, and default_worker", () => {
    const res = toWireStepPlugins(builtinRegistry);
    const byName = Object.fromEntries(res.step_plugins.map((p) => [p.name, p]));

    expect(byName.binary).toEqual({
      name: "binary",
      fields: {
        command: { type: "string", optional: false },
        args: { type: "array", optional: true, element: { type: "string", optional: false } },
        cwd: { type: "string", optional: true },
      },
      workers: ["spawn"],
      default_worker: "spawn",
    });

    expect(byName.prompt).toEqual({
      name: "prompt",
      fields: { prompt: { type: "string", optional: false } },
      workers: ["sdk"],
      default_worker: "sdk",
    });
  });

  it("serves every worker name of a >1-worker type, with its declared default", () => {
    const registry: StepPluginRegistry = {
      "api-call": {
        fields: { endpoint: z.string(), method: z.string().optional() },
        config: {},
        workers: {
          fetch: { run: doNotRun, meters: false, needsProcessorSlot: false },
          sdk: { run: doNotRun, meters: true, needsProcessorSlot: true },
        },
        defaultWorker: "fetch",
      },
    };

    const [entry] = toWireStepPlugins(registry).step_plugins;
    expect(entry).toEqual({
      name: "api-call",
      fields: {
        endpoint: { type: "string", optional: false },
        method: { type: "string", optional: true },
      },
      workers: ["fetch", "sdk"],
      default_worker: "fetch",
    });
  });

  it("degrades an unrecognized field kind to its bare type rather than throwing", () => {
    const registry: StepPluginRegistry = {
      exotic: {
        fields: { when: z.date() },
        config: {},
        workers: { only: { run: doNotRun, meters: false, needsProcessorSlot: false } },
        defaultWorker: "only",
      },
    };
    const [entry] = toWireStepPlugins(registry).step_plugins;
    expect(entry!.fields.when).toEqual({ type: "date", optional: false });
  });
});
