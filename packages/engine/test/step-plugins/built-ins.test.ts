import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeWorkflowFileSchema, safeParseWorkflowFileWith, toWireStepPlugins } from "@path/schema";

import { scanStepPlugins, STEP_PLUGINS_DIR } from "../../src/plugin/scan.js";
import type { StepRequest, StepResult } from "../../src/plugin/seam.js";

// The end-to-end dogfood of the public surface (#336, ADR 0019 sub-10): the two shipped built-in leaf
// step types are loaded through the real scanner (#335) from the real `plugin/step-plugin/` directory, and a
// `binary` and a `prompt` node are validated through the schema factory (#334). Nothing is stubbed —
// the folders resolve `@path/engine/plugin` exactly as a third-party plugin folder would.

const UUID_FILE = "00000000-0000-4000-8000-000000000000";
const UUID_BINARY = "11111111-1111-4111-8111-111111111111";
const UUID_PROMPT = "22222222-2222-4222-8222-222222222222";

async function loadRegistry() {
  const registry = await scanStepPlugins(STEP_PLUGINS_DIR);
  return registry;
}

describe("the shipped built-ins load through the scanner", () => {
  it("registers `binary` and `prompt` from the real step-plugin directory", async () => {
    const registry = await loadRegistry();

    expect(registry.binary).toBeDefined();
    expect(registry.prompt).toBeDefined();
    expect(registry.binary!.defaultWorker).toBe("spawn");
    expect(registry.prompt!.defaultWorker).toBe("anthropic");
  });

  it("declares the processor-slot and metering flags per worker", async () => {
    const registry = await loadRegistry();

    // `prompt`'s `anthropic` needs a processor slot and meters; `binary`'s `spawn` stays uncapped and meters nothing.
    expect(registry.prompt!.workers.anthropic).toMatchObject({ needsProcessorSlot: true, meters: true });
    expect(registry.binary!.workers.spawn).toMatchObject({ needsProcessorSlot: false, meters: false });
  });

  it("exposes no type name on either plugin — the folder name is the type", async () => {
    const registry = await loadRegistry();

    expect(registry.binary).not.toHaveProperty("type");
    expect(registry.prompt).not.toHaveProperty("type");
  });
});

describe("the `prompt` plugin's two model workers", () => {
  it("ships `anthropic` as the default and `deepseek` beside it", async () => {
    const registry = await loadRegistry();

    expect(Object.keys(registry.prompt!.workers)).toEqual(["anthropic", "deepseek"]);
    expect(registry.prompt!.defaultWorker).toBe("anthropic");
  });

  it("gives both workers the same capabilities — each makes one metered processor call per step-run", async () => {
    const registry = await loadRegistry();

    expect(registry.prompt!.workers.anthropic).toMatchObject({ meters: true, needsProcessorSlot: true });
    expect(registry.prompt!.workers.deepseek).toMatchObject({ meters: true, needsProcessorSlot: true });
  });

  it("declares no vendor field on the node — selecting a provider is the `worker` envelope field", async () => {
    const registry = await loadRegistry();

    expect(Object.keys(registry.prompt!.fields)).toEqual(["prompt"]);
  });

  it("offers both workers on the wire, so no surface restates the provider list", async () => {
    const registry = await loadRegistry();
    // The same projection `GET /v0/step-plugins` serves the browser Designer (wire-step-plugins.ts);
    // its worker dropdown appears whenever a type ships more than one.
    const response = toWireStepPlugins(registry);
    const prompt = response.step_plugins.find((p) => p.name === "prompt")!;

    expect(prompt.workers).toEqual(["anthropic", "deepseek"]);
    expect(prompt.default_worker).toBe("anthropic");
  });

  it("validates a prompt step that names either worker, and one that names none", async () => {
    const registry = await loadRegistry();
    const schema = makeWorkflowFileSchema(registry);
    const body = (worker?: string) => ({
      format: "path/workflow@5",
      id: UUID_FILE,
      name: "providers",
      body: [{ type: "prompt", id: UUID_PROMPT, name: "summarize", prompt: "Summarize the diff.", ...(worker === undefined ? {} : { worker }) }],
    });

    expect(safeParseWorkflowFileWith(schema, body("deepseek")).success).toBe(true);
    expect(safeParseWorkflowFileWith(schema, body("anthropic")).success).toBe(true);
    expect(safeParseWorkflowFileWith(schema, body()).success).toBe(true);
  });

  it("rejects a worker name the type does not ship, at load, naming the valid ones", async () => {
    const registry = await loadRegistry();
    const schema = makeWorkflowFileSchema(registry);

    const result = safeParseWorkflowFileWith(schema, {
      format: "path/workflow@5",
      id: UUID_FILE,
      name: "providers",
      body: [{ type: "prompt", id: UUID_PROMPT, name: "summarize", prompt: "Summarize the diff.", worker: "openai" }],
    });

    expect(result.success).toBe(false);
    // The `(type, name)` pair is a worker's identity, so an unknown name is a load error — never a
    // silent fallback to the default worker.
    expect(JSON.stringify(result)).toContain("openai");
  });
});

describe("the scanned built-ins validate through the schema factory", () => {
  it("accepts a workflow file with a `binary` and a `prompt` node", async () => {
    const registry = await loadRegistry();
    const schema = makeWorkflowFileSchema(registry);

    const file = {
      format: "path/workflow@5",
      id: UUID_FILE,
      name: "built-ins",
      body: [
        { type: "binary", id: UUID_BINARY, name: "build", command: "git", args: ["status"] },
        { type: "prompt", id: UUID_PROMPT, name: "summarize", prompt: "Summarize the diff." },
      ],
    };

    const result = safeParseWorkflowFileWith(schema, file);

    expect(result.success).toBe(true);
  });

  it("rejects a `binary` field the plugin does not declare (the factory's `.strict()`)", async () => {
    const registry = await loadRegistry();
    const schema = makeWorkflowFileSchema(registry);

    const file = {
      format: "path/workflow@5",
      id: UUID_FILE,
      name: "built-ins",
      body: [{ type: "binary", id: UUID_BINARY, name: "build", command: "git", bogus: true }],
    };

    const result = safeParseWorkflowFileWith(schema, file);

    expect(result.success).toBe(false);
  });
});

describe("the `binary` spawn worker", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "binary-spawn-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Run the real `spawn` worker the scanner loaded, so the assertion covers the shipped code.
  async function runSpawn(fields: { command: string; args?: string[]; cwd?: string }, cwd: string): Promise<StepResult> {
    const registry = await loadRegistry();
    const request: StepRequest = {
      fields,
      input: {},
      config: {},
      cwd,
      signal: new AbortController().signal,
    };
    return registry.binary!.workers.spawn!.run(request);
  }

  it("resolves its `cwd` field against `request.cwd`", async () => {
    // A relative `cwd` field anchors to `request.cwd` (the workflow file's directory), never process.cwd().
    const result = await runSpawn(
      { command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"], cwd: "." },
      dir,
    );

    expect(result).toMatchObject({ status: "succeeded" });
    // `tmpdir()` may be a symlink (macOS `/var`→`/private/var`); the child reports the resolved real path.
    const realDir = await realpath(dir);
    if (result.status === "succeeded") {
      expect(result.output).toBe(realDir);
    }
  });

  it("names no step in a non-zero-exit error", async () => {
    const result = await runSpawn(
      { command: process.execPath, args: ["-e", "process.stderr.write('boom');process.exit(2)"] },
      dir,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("exited with code 2: boom");
      expect(result.error).not.toContain("step");
    }
  });

  it("names no step in a start failure — only the command", async () => {
    const result = await runSpawn({ command: "path-no-such-binary-336" }, dir);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain('failed to start "path-no-such-binary-336"');
      expect(result.error).not.toContain("step");
    }
  });
});
