import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeParseStepTemplate, safeParseWorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinRegistry } from "./builtin-registry.js";
import { runCodemod } from "./run-codemod.js";

/**
 * The `@4` → `@5` codemod, black-box (#621, ADR 0058 §6). `@5` bumps for the `goto` controller, but a
 * goto-free `@4` file is already a valid `@5` file, so like the `@4` codemod this one only stamps the
 * version. Unlike it, it also carries Step-Templates and Workflow-Templates (they stamp the shared
 * `FORMAT_VERSION`, ADR 0048 §1) and discovers files under `.path/template/`, so the pins are: only
 * `format` moves, byte-for-byte (G-S-10); it refuses nothing; it is idempotent; discovery finds all
 * three suffixes.
 */
const V5 = "migrate-workflow-format-v5.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-codemod-v5-"));
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

const workflow = {
  format: "path/workflow@4",
  id: UUID,
  name: "wf",
  worker_defaults: { prompt: "deepseek" },
  body: [{ type: "prompt", id: UUID, name: "ask", prompt: "Hi." }],
};

describe("migrate-workflow-format-v5 — the no-op format stamp", () => {
  it("G-S-10: a goto-free @4 workflow is byte-identical except `format`, and loads", () => {
    // Hand-formatted on purpose — compact arrays, no trailing newline — so a re-serialize would show.
    const text = `{"format": "path/workflow@4", "id": "${UUID}",\n  "name": "wf",\n  "body": [{"type": "binary", "id": "${UUID}", "name": "one", "command": "echo"}]}`;
    const file = writeRaw("plain.workflow.json", text);

    const { status } = runCodemod([file], dir, V5);
    expect(status).toBe(0);

    expect(bytes(file)).toBe(text.replace("path/workflow@4", "path/workflow@5"));
    const result = safeParseWorkflowFile(read(file), builtinRegistry);
    expect(result.success, result.success ? "" : result.errors.join("\n")).toBe(true);
  });

  it("G-S-10: a @4 Step-Template is byte-identical except `format`, and loads", () => {
    const file = write("gate.step-template.json", {
      format: "path/workflow@4",
      id: UUID,
      description: "One gate",
      body: [{ type: "binary", id: UUID, name: "one", command: "echo" }],
    });
    const before = bytes(file);

    runCodemod([file], dir, V5);

    expect(bytes(file)).toBe(before.replace("path/workflow@4", "path/workflow@5"));
    const result = safeParseStepTemplate(read(file), builtinRegistry);
    expect(result.success, result.success ? "" : result.errors.join("\n")).toBe(true);
  });

  it("is idempotent — an already-@5 file is left byte-unchanged", () => {
    const file = write("already.workflow.json", { ...workflow, format: "path/workflow@5" });
    const before = bytes(file);

    const { status } = runCodemod([file], dir, V5);
    expect(status).toBe(0);
    expect(bytes(file)).toBe(before);
  });

  it("leaves a file at an older format untouched (it is not this codemod's step)", () => {
    const file = write("older.workflow.json", { ...workflow, format: "path/workflow@3" });
    const before = bytes(file);

    const { status } = runCodemod([file], dir, V5);
    expect(status).toBe(0);
    expect(bytes(file)).toBe(before);
  });

  it("discovers all three suffixes under the root and .path/template/, skipping other dot dirs", () => {
    const found = [
      write("a.workflow.json", workflow),
      write("sub/b.step-template.json", workflow),
      write("c.workflow-template.json", workflow),
      write(".path/template/step-template/d.step-template.json", workflow),
      write(".path/template/workflow-template/e.workflow-template.json", workflow),
    ];
    const ignored = [
      write(".path/runs/f.workflow.json", workflow),
      write(".hidden/g.workflow.json", workflow),
      write("node_modules/h.workflow.json", workflow),
      write("i.json", workflow),
    ];

    const { status } = runCodemod([], dir, V5);
    expect(status).toBe(0);

    for (const file of found) expect(read(file).format, file).toBe("path/workflow@5");
    for (const file of ignored) expect(read(file).format, file).toBe("path/workflow@4");
  });
});
