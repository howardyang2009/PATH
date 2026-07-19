import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowFile, type WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/run-workflow.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): WorkflowFile {
  return parseWorkflowFile(JSON.parse(readFileSync(join(fixturesDir, name), "utf8")));
}

describe("runWorkflow", () => {
  it("threads the first binary step's stdout into the second step's stdin", async () => {
    const file = loadFixture("two-binary-steps.workflow.json");
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("succeeded");
    expect(result.output).toBe("HELLO");
  });

  it("fails fast on a non-zero exit and does not run subsequent steps", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "fail-fast",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "boom", command: "node", args: ["-e", "process.exit(3)"] },
        {
          type: "binary",
          id: "never",
          command: "node",
          args: ["-e", "process.stdout.write('should not run')"],
        },
      ],
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/boom/);
    expect(result.error).toMatch(/\b3\b/);
  });

  it("uses the workflow's own input object as the first step's default input", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "echo-input",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "echo",
          command: "node",
          args: [
            "-e",
            "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))",
          ],
        },
      ],
    };
    const result = await runWorkflow(file, fixturesDir, { greeting: "hi" });
    expect(result.status).toBe("succeeded");
    expect(JSON.parse(result.output as string)).toEqual({ greeting: "hi" });
  });

  it("respects a step's own cwd override", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "cwd-check",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "pwd",
          command: "node",
          args: ["-e", "process.stdout.write(process.cwd())"],
          cwd: fixturesDir,
        },
      ],
    };
    const result = await runWorkflow(file, "/tmp");
    expect(result.status).toBe("succeeded");
    expect(result.output).toBe(fixturesDir);
  });

  it("fails clearly on unsupported step types instead of silently skipping them", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "prompt-not-supported",
      worker: { type: "llm", model: "claude" },
      body: [{ type: "prompt", id: "ask", prompt: "hello" }],
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/prompt/i);
  });
});
