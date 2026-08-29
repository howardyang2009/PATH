import { z } from "zod";
import type { StepPluginRegistry } from "@path/schema";

/**
 * A registry mirroring the two shipped built-in leaf step types (`binary`, `prompt`) at the level
 * `@path/schema` reads — the two zod fragments and the worker *names*. The closed built-in union is
 * gone (#337): a test that needs a `binary`/`prompt` node to validate builds its schema from this
 * fixture, the same grammar the engine builds from its `step-plugins/` folder scan. `run` is a reject
 * stub the schema never calls. Kept byte-for-byte in step with `packages/schema/test/builtin-registry.ts`
 * (a test fixture is not part of a package's exports, so the two cannot share one module).
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
