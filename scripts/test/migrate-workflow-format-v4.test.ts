import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeParseWorkflowFile } from "@path/schema";
import { builtinRegistry } from "./builtin-registry.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodemod } from "./run-codemod.js";

/**
 * The `@3` → `@4` codemod, black-box (#514, ADR 0044). `worker_defaults` is a file-level envelope
 * grammar change, so the format version bumps `@3` → `@4` (workflow-format-v4.md), but the shape a
 * `@3` file already carries is a valid `@4` file: the codemod only rewrites the `format` string. So
 * unlike its predecessors it holds no rewrite and no refusal — the only thing to pin is that it stamps
 * the version, touches nothing else, and is idempotent.
 */
const V4 = "migrate-workflow-format-v4.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-codemod-v4-"));
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

/**
 * The migrated document must be a *loadable* file, not merely a reshaped one. `@4` is superseded now
 * (the schema reads `@5`), so lift a copy the rest of the way with the `@5` codemod first.
 */
function expectSchemaValid(file: string): void {
  const copy = `${file}.v5.json`;
  writeFileSync(copy, readFileSync(file, "utf8"));
  runCodemod([copy], dir, "migrate-workflow-format-v5.ts");
  const result = safeParseWorkflowFile(read(copy), builtinRegistry);
  expect(result.success, result.success ? "" : result.errors.join("\n")).toBe(true);
}

describe("migrate-workflow-format-v4 — the no-op format stamp", () => {
  it("stamps a @3 file to @4 and changes nothing else", () => {
    const file = write("plain.workflow.json", {
      format: "path/workflow@3",
      id: UUID,
      name: "wf",
      config: { model: "claude-sonnet-5" },
      body: [{ type: "prompt", id: UUID, name: "ask", prompt: "Hi.", worker: "anthropic" }],
    });

    const { status } = runCodemod([file], dir, V4);
    expect(status).toBe(0);

    const doc = read(file);
    expect(doc.format).toBe("path/workflow@4");
    // Every other field is byte-for-byte what it was: only `format` moved.
    expect({ ...doc, format: "path/workflow@3" }).toEqual({
      format: "path/workflow@3",
      id: UUID,
      name: "wf",
      config: { model: "claude-sonnet-5" },
      body: [{ type: "prompt", id: UUID, name: "ask", prompt: "Hi.", worker: "anthropic" }],
    });
    expectSchemaValid(file);
  });

  it("carries a file's worker_defaults through untouched", () => {
    const file = write("defaults.workflow.json", {
      format: "path/workflow@3",
      id: UUID,
      name: "wf",
      worker_defaults: { prompt: "deepseek" },
      body: [{ type: "prompt", id: UUID, name: "ask", prompt: "Hi." }],
    });

    runCodemod([file], dir, V4);

    const doc = read(file);
    expect(doc.format).toBe("path/workflow@4");
    expect(doc.worker_defaults).toEqual({ prompt: "deepseek" });
    expectSchemaValid(file);
  });

  it("is idempotent — an already-@4 file is left byte-unchanged", () => {
    const file = write("already.workflow.json", {
      format: "path/workflow@4",
      id: UUID,
      name: "wf",
      body: [{ type: "binary", id: UUID, name: "step-one", command: "echo" }],
    });
    const before = bytes(file);

    const { status } = runCodemod([file], dir, V4);
    expect(status).toBe(0);
    expect(bytes(file)).toBe(before);
  });

  it("leaves a file at an older format untouched (it is not this codemod's step)", () => {
    const file = write("older.workflow.json", {
      format: "path/workflow@2",
      id: UUID,
      name: "wf",
      worker: { type: "engine" },
      body: [{ type: "binary", id: UUID, name: "step-one", command: "echo" }],
    });
    const before = bytes(file);

    const { status } = runCodemod([file], dir, V4);
    expect(status).toBe(0);
    expect(bytes(file)).toBe(before);
  });
});
