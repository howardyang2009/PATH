import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeWorkflowFileSchema, safeParseWorkflowFileWith } from "@path/schema";

import { scanStepPlugins, STEP_PLUGINS_DIR } from "../../src/plugin/scan.js";
import type { StepRequest, StepResult } from "../../src/plugin/seam.js";

// The end-to-end dogfood of the public surface (#336, ADR 0019 sub-10): the two shipped built-in leaf
// step types are loaded through the real scanner (#335) from the real `step-plugins/` directory, and a
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
  it("registers `binary` and `prompt` from the real step-plugins directory", async () => {
    const registry = await loadRegistry();

    expect(registry.binary).toBeDefined();
    expect(registry.prompt).toBeDefined();
    expect(registry.binary!.defaultWorker).toBe("spawn");
    expect(registry.prompt!.defaultWorker).toBe("sdk");
  });

  it("declares the processor-slot and metering flags per worker", async () => {
    const registry = await loadRegistry();

    // `prompt`'s `sdk` needs a processor slot and meters; `binary`'s `spawn` stays uncapped and meters nothing.
    expect(registry.prompt!.workers.sdk).toMatchObject({ needsProcessorSlot: true, meters: true });
    expect(registry.binary!.workers.spawn).toMatchObject({ needsProcessorSlot: false, meters: false });
  });

  it("exposes no type name on either plugin — the folder name is the type", async () => {
    const registry = await loadRegistry();

    expect(registry.binary).not.toHaveProperty("type");
    expect(registry.prompt).not.toHaveProperty("type");
  });
});

describe("the scanned built-ins validate through the schema factory", () => {
  it("accepts a workflow file with a `binary` and a `prompt` node", async () => {
    const registry = await loadRegistry();
    const schema = makeWorkflowFileSchema(registry);

    const file = {
      format: "path/workflow@3",
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
      format: "path/workflow@3",
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
