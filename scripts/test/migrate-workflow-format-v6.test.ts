import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeParseStepTemplate, safeParseWorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinRegistry } from "./builtin-registry.js";
import { runCodemod } from "./run-codemod.js";

/**
 * The `@5` → `@6` codemod, black-box (ADR 0079). `@6` removes `output` from the condition roots,
 * so the pins are: `format` moves, and every condition path rooted at `output` moves to `previous`
 * at any depth; nothing else changes, byte-for-byte where the text allows; it refuses nothing; it
 * is idempotent; discovery finds all three suffixes.
 */
const V6 = "migrate-workflow-format-v6.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-codemod-v6-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const UUID = "11111111-1111-4111-8111-111111111111";

function writeRaw(file: string, text: string): string {
  const full = join(dir, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

const write = (file: string, doc: unknown): string =>
  writeRaw(file, `${JSON.stringify(doc, null, 2)}\n`);
const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8"));
const bytes = (file: string): string => readFileSync(file, "utf8");

const echo = (name: string) => ({ type: "binary", id: UUID, name, command: "echo" });

const workflow = {
  format: "path/workflow@5",
  id: UUID,
  name: "wf",
  body: [echo("one")],
};

// Every condition slot, with `output` bare, dotted, and nested under all / any / not.
const conditioned = {
  format: "path/workflow@5",
  id: UUID,
  name: "wf",
  body: [
    echo("pick"),
    {
      type: "branch",
      id: UUID,
      name: "route",
      arms: [
        { when: { type: "equals", path: "output.choice", value: "a" }, node: echo("arm-a") },
        {
          when: {
            type: "all",
            of: [
              { type: "exists", path: "output" },
              { type: "not", of: { type: "equals", path: "output.choice", value: "a" } },
              { type: "any", of: [{ type: "exists", path: "context.x" }] },
            ],
          },
          node: echo("arm-b"),
        },
      ],
      else: echo("fallback"),
    },
    { type: "checkpoint", id: UUID, name: "gate", condition: { type: "exists", path: "output" } },
    {
      type: "while-do",
      id: UUID,
      name: "loop",
      max_iterations: 3,
      condition: { type: "matches", path: "output.status", pattern: "^again$" },
      node: echo("body"),
    },
  ],
};

describe("migrate-workflow-format-v6 — `output` condition paths move to `previous`", () => {
  it("a condition-free @5 workflow is byte-identical except `format`, and loads", () => {
    // Hand-formatted on purpose — compact arrays, no trailing newline — so a re-serialize would
    // show.
    const text = `{"format": "path/workflow@5", "id": "${UUID}",\n  "name": "wf",\n  "body": [{"type": "binary", "id": "${UUID}", "name": "one", "command": "echo"}]}`;
    const file = writeRaw("plain.workflow.json", text);

    const { status } = runCodemod([file], dir, V6);
    expect(status).toBe(0);

    expect(bytes(file)).toBe(text.replace("path/workflow@5", "path/workflow@6"));
    const result = safeParseWorkflowFile(read(file), builtinRegistry);
    expect(result.success, result.success ? "" : result.errors.join("\n")).toBe(true);
  });

  it("rewrites every condition slot at any depth, byte-preserving the rest, and loads", () => {
    const file = write("cond.workflow.json", conditioned);
    const before = bytes(file);

    runCodemod([file], dir, V6);

    expect(bytes(file)).toBe(
      before
        .replace("path/workflow@5", "path/workflow@6")
        .replaceAll('"path": "output', '"path": "previous'),
    );
    const result = safeParseWorkflowFile(read(file), builtinRegistry);
    expect(result.success, result.success ? "" : result.errors.join("\n")).toBe(true);
  });

  it("leaves a `path` outside any condition alone, falling back to a re-serialize", () => {
    // The file-level `input` seed is plain JSON: a `path` key there is data, not a condition.
    const file = write("seed.workflow.json", {
      ...conditioned,
      input: { path: "output.keep" },
    });

    runCodemod([file], dir, V6);

    const doc = read(file);
    expect(doc.input).toEqual({ path: "output.keep" });
    expect(JSON.stringify(doc.body)).not.toContain('"output');
    const result = safeParseWorkflowFile(doc, builtinRegistry);
    expect(result.success, result.success ? "" : result.errors.join("\n")).toBe(true);
  });

  it("migrates a Step-Template, and it loads", () => {
    const file = write("switch.step-template.json", {
      format: "path/workflow@5",
      id: UUID,
      description: "One switch",
      body: conditioned.body,
    });

    runCodemod([file], dir, V6);

    expect(bytes(file)).not.toContain('"output');
    const result = safeParseStepTemplate(read(file), builtinRegistry);
    expect(result.success, result.success ? "" : result.errors.join("\n")).toBe(true);
  });

  it("is idempotent — an already-@6 file is left byte-unchanged", () => {
    const file = write("already.workflow.json", { ...workflow, format: "path/workflow@6" });
    const before = bytes(file);

    const { status } = runCodemod([file], dir, V6);
    expect(status).toBe(0);
    expect(bytes(file)).toBe(before);
  });

  it("leaves a file at an older format untouched (it is not this codemod's step)", () => {
    const file = write("older.workflow.json", { ...conditioned, format: "path/workflow@4" });
    const before = bytes(file);

    const { status } = runCodemod([file], dir, V6);
    expect(status).toBe(0);
    expect(bytes(file)).toBe(before);
  });

  it("discovers all three suffixes under the root and .path/template/, skipping other dot dirs", () => {
    const found = [
      write("a.workflow.json", workflow),
      write("sub/b.step-template.json", workflow),
      write("c.workflow-template.json", workflow),
      write(".path/template/step-template/d.step-template.json", workflow),
    ];
    const ignored = [
      write(".path/runs/f.workflow.json", workflow),
      write(".hidden/g.workflow.json", workflow),
      write("node_modules/h.workflow.json", workflow),
      write("i.json", workflow),
    ];

    const { status } = runCodemod([], dir, V6);
    expect(status).toBe(0);

    for (const file of found) expect(read(file).format, file).toBe("path/workflow@6");
    for (const file of ignored) expect(read(file).format, file).toBe("path/workflow@5");
  });
});
