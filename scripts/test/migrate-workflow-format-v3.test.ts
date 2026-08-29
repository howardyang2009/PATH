import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeParseWorkflowFile } from "@path/schema";
import { builtinRegistry } from "./builtin-registry.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodemod } from "./run-codemod.js";

/**
 * The `@2` → `@3` codemod, black-box (ADR 0021, #332) — the worker-name migration.
 *
 * The two behaviours the ADR argues for by name go unexercised by the repo's own files (none hits a
 * refusal, and every file reaches its type default), so they are pinned here: the **rewrite** (delete
 * an `engine` worker; hoist an `llm` worker's `model`/`options` into config; delete a `workflow`
 * step's worker) and the two **refusals** (an interpolated `model`/`options`, and a `prompt` step
 * whose effective worker is `engine`), each proven to name the file and the JSON pointer and to exit
 * non-zero leaving the file byte-unchanged.
 *
 * Driven through the process, not the module: the subprocess reaches the `process.exitCode = 1` and
 * the stderr report a unit test of `migrateDocument` cannot.
 */
const V3 = "migrate-workflow-format-v3.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-codemod-v3-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const UUID = "11111111-1111-4111-8111-111111111111";

function write(file: string, doc: unknown): string {
  const full = join(dir, file);
  writeFileSync(full, `${JSON.stringify(doc, null, 2)}\n`);
  return full;
}

const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8"));
const bytes = (file: string): string => readFileSync(file, "utf8");

/** The migrated document must be a *loadable* `@3` file, not merely a reshaped one. */
function expectSchemaValid(file: string): void {
  const result = safeParseWorkflowFile(read(file), builtinRegistry);
  expect(result.success, result.success ? "" : result.errors.join("\n")).toBe(true);
}

describe("migrate-workflow-format-v3 — the rewrite", () => {
  it("bumps the format and deletes a file-level and step-level engine worker", () => {
    const file = write("engine.workflow.json", {
      format: "path/workflow@2",
      id: UUID,
      name: "wf",
      worker: { type: "engine" },
      body: [{ type: "binary", id: UUID, name: "step-one", worker: { type: "engine" }, command: "echo" }],
    });

    const { status } = runCodemod([file], dir, V3);
    expect(status).toBe(0);

    const doc = read(file);
    expect(doc.format).toBe("path/workflow@3");
    expect(doc).not.toHaveProperty("worker");
    expect((doc.body as { worker?: unknown }[])[0]).not.toHaveProperty("worker");
    expectSchemaValid(file);
  });

  it("hoists a file-level llm worker's model into the file's own config", () => {
    const file = write("file-llm.workflow.json", {
      format: "path/workflow@2",
      id: UUID,
      name: "wf",
      worker: { type: "llm", model: "claude-sonnet-5" },
      config: { subject: "release" },
      body: [{ type: "prompt", id: UUID, name: "ask", prompt: "Summarize ${config.subject}." }],
    });

    runCodemod([file], dir, V3);

    const doc = read(file);
    expect(doc).not.toHaveProperty("worker");
    expect(doc.config).toEqual({ subject: "release", model: "claude-sonnet-5" });
    expectSchemaValid(file);
  });

  it("hoists a step-level llm worker's model and options into that step's own config", () => {
    const file = write("step-llm.workflow.json", {
      format: "path/workflow@2",
      id: UUID,
      name: "wf",
      worker: { type: "engine" },
      body: [
        {
          type: "prompt",
          id: UUID,
          name: "ask",
          prompt: "Hi.",
          worker: { type: "llm", model: "claude-opus-4-8", options: { mcpServers: { docs: { type: "stdio" } } } },
        },
      ],
    });

    runCodemod([file], dir, V3);

    const step = (read(file).body as Record<string, unknown>[])[0]!;
    expect(step).not.toHaveProperty("worker");
    expect(step.config).toEqual({ model: "claude-opus-4-8", options: { mcpServers: { docs: { type: "stdio" } } } });
    expectSchemaValid(file);
  });

  it("deletes the worker key on a workflow step without hoisting anything", () => {
    const file = write("wf-step.workflow.json", {
      format: "path/workflow@2",
      id: UUID,
      name: "wf",
      worker: { type: "engine" },
      body: [{ type: "workflow", id: UUID, name: "call", ref: "./child.workflow.json", worker: { type: "llm", model: "m" } }],
    });

    runCodemod([file], dir, V3);

    const step = (read(file).body as Record<string, unknown>[])[0]!;
    expect(step).not.toHaveProperty("worker");
    expect(step).not.toHaveProperty("config");
  });

  it("deletes an exactly-`${config.model}` worker model without writing an inert literal (benign no-op)", () => {
    const file = write("benign.workflow.json", {
      format: "path/workflow@2",
      id: UUID,
      name: "wf",
      worker: { type: "engine" },
      config: { model: "claude-sonnet-5" },
      body: [{ type: "prompt", id: UUID, name: "ask", prompt: "Hi.", worker: { type: "llm", model: "${config.model}" } }],
    });

    const { status } = runCodemod([file], dir, V3);
    expect(status).toBe(0);

    const step = (read(file).body as Record<string, unknown>[])[0]!;
    expect(step).not.toHaveProperty("worker");
    // No inert `model: "${config.model}"` written into the step — the file's config.model still drives it.
    expect(step).not.toHaveProperty("config");
    expectSchemaValid(file);
  });

  it("leaves an already-@3 file byte-unchanged", () => {
    const file = write("already.workflow.json", {
      format: "path/workflow@3",
      id: UUID,
      name: "wf",
      body: [{ type: "binary", id: UUID, name: "step-one", command: "echo" }],
    });
    const before = bytes(file);

    const { status } = runCodemod([file], dir, V3);
    expect(status).toBe(0);
    expect(bytes(file)).toBe(before);
  });
});

describe("migrate-workflow-format-v3 — the refusals (ADR 0021 sub-12)", () => {
  it("refuses an interpolated model, naming the file and the JSON pointer, and leaves the file unchanged", () => {
    const file = write("interp-model.workflow.json", {
      format: "path/workflow@2",
      id: UUID,
      name: "wf",
      worker: { type: "engine" },
      body: [{ type: "prompt", id: UUID, name: "ask", prompt: "Hi.", worker: { type: "llm", model: "${context.chosen}" } }],
    });
    const before = bytes(file);

    const { status, stderr } = runCodemod([file], dir, V3);
    expect(status).toBe(1);
    expect(stderr).toContain(file);
    expect(stderr).toContain("/body/0/worker/model");
    expect(bytes(file)).toBe(before);
  });

  it("refuses an interpolated options bag, naming the file and the JSON pointer", () => {
    const file = write("interp-options.workflow.json", {
      format: "path/workflow@2",
      id: UUID,
      name: "wf",
      worker: { type: "engine" },
      body: [
        {
          type: "prompt",
          id: UUID,
          name: "ask",
          prompt: "Hi.",
          worker: { type: "llm", model: "m", options: { systemPrompt: "for ${config.subject}" } },
        },
      ],
    });
    const before = bytes(file);

    const { status, stderr } = runCodemod([file], dir, V3);
    expect(status).toBe(1);
    expect(stderr).toContain(file);
    expect(stderr).toContain("/body/0/worker/options");
    expect(bytes(file)).toBe(before);
  });

  it("refuses a prompt step whose own worker is engine, naming the file and the JSON pointer", () => {
    const file = write("prompt-engine.workflow.json", {
      format: "path/workflow@2",
      id: UUID,
      name: "wf",
      worker: { type: "engine" },
      body: [{ type: "prompt", id: UUID, name: "ask", prompt: "Hi.", worker: { type: "engine" } }],
    });
    const before = bytes(file);

    const { status, stderr } = runCodemod([file], dir, V3);
    expect(status).toBe(1);
    expect(stderr).toContain(file);
    expect(stderr).toContain("/body/0/worker");
    expect(bytes(file)).toBe(before);
  });

  it("refuses a prompt step that inherits an engine file worker (effective worker is engine)", () => {
    const file = write("prompt-inherits-engine.workflow.json", {
      format: "path/workflow@2",
      id: UUID,
      name: "wf",
      worker: { type: "engine" },
      body: [{ type: "prompt", id: UUID, name: "ask", prompt: "Hi." }],
    });
    const before = bytes(file);

    const { status, stderr } = runCodemod([file], dir, V3);
    expect(status).toBe(1);
    expect(stderr).toContain("/body/0/worker");
    expect(bytes(file)).toBe(before);
  });
});
