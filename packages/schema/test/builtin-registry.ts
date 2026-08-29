import { z } from "zod";
import type { StepPluginRegistry } from "../src/nodes.js";

/**
 * A registry mirroring the two shipped built-in leaf step types (`binary`, `prompt`) at the level
 * `@path/schema` reads — the two zod fragments and the worker *names*. `@path/schema` no longer
 * hardcodes these types (the closed union is gone, ADR 0019 sub-10 / #337): a test that needs a
 * `binary` or `prompt` node to validate builds its schema from this fixture, the same way the engine
 * builds one from its folder scan. `run` is a reject stub the schema must never call (purity).
 */
const doNotRun = () => Promise.reject(new Error("run must not be called at validation"));

export const builtinRegistry: StepPluginRegistry = {
  binary: {
    fields: { command: z.string(), args: z.array(z.string()).optional(), cwd: z.string().optional() },
    config: {},
    workers: { spawn: { run: doNotRun, meters: false, needsProcessorSlot: false } },
    defaultWorker: "spawn",
  },
  prompt: {
    fields: { prompt: z.string() },
    config: { model: z.string(), options: z.record(z.unknown()).optional() },
    workers: { sdk: { run: doNotRun, meters: true, needsProcessorSlot: true } },
    defaultWorker: "sdk",
  },
};
