import { spawn } from "node:child_process";
import type { BinaryStep, JsonValue, WorkflowFile } from "@path/schema";

// Shaped differently from @path/schema's success/failure results: a failed run still carries
// the last-succeeded node's output (useful to a caller even on failure), so `output` is
// unconditional rather than living only in a success branch.
export interface RunResult {
  status: "succeeded" | "failed";
  /** Output object of the last node that actually ran (mvp spec §5.4). */
  output: JsonValue;
  error?: string;
}

type BinaryStepResult = { success: true; output: string } | { success: false; error: string };

// I/O convention per format doc §4.2: input object on stdin (raw if a string, else its JSON
// serialization), captured stdout is the output, non-zero exit fails the step.
function runBinaryStep(node: BinaryStep, defaultCwd: string, input: JsonValue): Promise<BinaryStepResult> {
  return new Promise((resolveResult) => {
    const child = spawn(node.command, node.args ?? [], { cwd: node.cwd ?? defaultCwd });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: BinaryStepResult) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      settle({ success: false, error: `step "${node.id}" failed to start "${node.command}": ${err.message}` });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().slice(-500);
        settle({
          success: false,
          error: `step "${node.id}" exited with code ${code}${tail ? `: ${tail}` : ""}`,
        });
        return;
      }
      settle({ success: true, output: stdout });
    });

    child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
    child.stdin.end();
  });
}

/**
 * Walks a workflow's body strictly sequentially (mvp spec §5.1) and executes `binary` steps
 * as child processes. Other node types are out of scope of the walking skeleton (ticket #16)
 * and fail the run with a clear message rather than being silently skipped.
 *
 * The domain model wraps the top-level workflow in an implicit root step (mvp spec §2,
 * invariant 2) whose run this body walk *is* — it isn't materialized as its own value here
 * because run records are #18's scope; the CLI reports this function's `RunResult` directly.
 */
export async function runWorkflow(
  file: WorkflowFile,
  fileDir: string,
  input: JsonValue = {},
): Promise<RunResult> {
  let previousOutput: JsonValue = input;
  const fail = (error: string): RunResult => ({ status: "failed", output: previousOutput, error });

  for (const node of file.body) {
    if (node.type !== "binary") {
      return fail(
        `step type "${node.type}" (node "${node.id}") is not supported yet — the walking skeleton runs binary steps only`,
      );
    }
    if (node.input !== undefined) {
      return fail(
        `explicit "input" (node "${node.id}") is not supported yet — only the default-input chain is implemented`,
      );
    }
    if (node.publish !== undefined) {
      return fail(`"publish" (node "${node.id}") is not supported yet`);
    }
    if (node.parse === "json") {
      return fail(`parse: "json" (node "${node.id}") is not supported yet`);
    }

    const result = await runBinaryStep(node, fileDir, previousOutput);
    if (!result.success) {
      return fail(result.error);
    }
    previousOutput = result.output;
  }

  return { status: "succeeded", output: previousOutput };
}
