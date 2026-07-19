import { spawn } from "node:child_process";
import type { ConfigObject, JsonValue, WorkflowFile } from "@path/schema";
import { InterpolationError, interpolateToString, interpolateValue, type InterpolationScope } from "./interpolate.js";
import { mergeConfig } from "./merge-config.js";
import { OutputParseError, parseStepOutput } from "./parse-output.js";

export interface RunOptions {
  /** The workflow's own input object (format doc §6.1); its top-level keys seed context (§6.3). */
  input?: { [key: string]: JsonValue };
  /** Operator launch-time config (CLI flags/file), overriding the top-level file's defaults (spec §3). */
  operatorConfig?: ConfigObject;
}

// Shaped differently from @path/schema's success/failure results: a failed run still carries
// the last-succeeded node's output (useful to a caller even on failure), so `output` is
// unconditional rather than living only in a success branch.
export interface RunResult {
  status: "succeeded" | "failed";
  /**
   * On success: the workflow's `output` map, evaluated at successful run end (format doc §6.4) —
   * absent map = `{}`. On failure: the last node's raw output that actually ran, for debugging;
   * the workflow has no output *contract* on a failed run.
   */
  output: JsonValue;
  error?: string;
}

type BinaryStepResult = { success: true; output: string } | { success: false; error: string };

// The step's `command`/`args`/`cwd` after interpolation — they travel together everywhere a
// binary step actually runs, so runBinaryStep takes this instead of three loose parameters.
interface ResolvedBinaryStep {
  id: string;
  command: string;
  args: string[];
  cwd: string;
}

// I/O convention per format doc §4.2: input object on stdin (raw if a string, else its JSON
// serialization), captured stdout is the output, non-zero exit fails the step.
function runBinaryStep(step: ResolvedBinaryStep, input: JsonValue): Promise<BinaryStepResult> {
  const { id: nodeId, command, args, cwd } = step;
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd });
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
      settle({ success: false, error: `step "${nodeId}" failed to start "${command}": ${err.message}` });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().slice(-500);
        settle({
          success: false,
          error: `step "${nodeId}" exited with code ${code}${tail ? `: ${tail}` : ""}`,
        });
        return;
      }
      settle({ success: true, output: stdout });
    });

    child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
    child.stdin.end();
  });
}

function describeInterpolationError(nodeId: string, err: unknown): string {
  if (err instanceof InterpolationError) return `node "${nodeId}": ${err.message}`;
  throw err; // an unexpected error is a bug, not a data-flow failure — surface it, don't swallow it
}

// ConfigObject and JsonValue are structurally compatible (config's `$secret` wrapper is just a
// plain object shape) but not nominally assignable across their recursive unions.
function configScope(config: ConfigObject): JsonValue {
  return config as unknown as JsonValue;
}

/**
 * Walks a workflow's body strictly sequentially (mvp spec §5.1) and executes `binary` steps
 * as child processes, resolving `${}` interpolation, `input`/`publish` maps, config inheritance,
 * and `parse: "json"` at each step (spec §2 invariant 4, format §5–6, §8). Other node types
 * remain out of scope of the walking skeleton (tickets #21–#24) and fail the run with a clear
 * message rather than being silently skipped.
 *
 * The domain model wraps the top-level workflow in an implicit root step (mvp spec §2,
 * invariant 2) whose run this body walk *is* — it isn't materialized as its own value here
 * because run records are #18's scope; the CLI reports this function's `RunResult` directly.
 */
export async function runWorkflow(
  file: WorkflowFile,
  fileDir: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const input = options.input ?? {};
  const context: { [key: string]: JsonValue } = { ...input }; // format doc §6.3
  let previousOutput: JsonValue = input;

  const fileConfig = mergeConfig(file.config ?? {}, options.operatorConfig);
  const fail = (error: string): RunResult => ({ status: "failed", output: previousOutput, error });

  for (const node of file.body) {
    if (node.type !== "binary") {
      return fail(
        `step type "${node.type}" (node "${node.id}") is not supported yet — the walking skeleton runs binary steps only`,
      );
    }

    const stepConfig = mergeConfig(fileConfig, node.config);
    const scope: InterpolationScope = { config: configScope(stepConfig), context };

    let stepInput: JsonValue;
    let command: string;
    let args: string[];
    let cwd: string;
    try {
      stepInput = node.input !== undefined ? interpolateValue(node.input, scope) : previousOutput;
      command = interpolateToString(node.command, scope);
      args = (node.args ?? []).map((arg) => interpolateToString(arg, scope));
      cwd = node.cwd !== undefined ? interpolateToString(node.cwd, scope) : fileDir;
    } catch (err) {
      return fail(describeInterpolationError(node.id, err));
    }

    const result = await runBinaryStep({ id: node.id, command, args, cwd }, stepInput);
    if (!result.success) {
      return fail(result.error);
    }

    let output: JsonValue = result.output;
    if (node.parse === "json") {
      try {
        output = parseStepOutput(result.output);
      } catch (err) {
        if (!(err instanceof OutputParseError)) throw err;
        return fail(`step "${node.id}": ${err.message}`);
      }
    }

    if (node.publish) {
      const publishScope: InterpolationScope = { config: configScope(stepConfig), context, output };
      const updates: { [key: string]: JsonValue } = {};
      try {
        for (const [key, expr] of Object.entries(node.publish)) {
          updates[key] = interpolateValue(expr, publishScope);
        }
      } catch (err) {
        return fail(describeInterpolationError(node.id, err));
      }
      // Publish lands atomically on step success, before the next node starts (spec §5.3):
      // every entry is resolved above before any of them is written to context.
      Object.assign(context, updates);
    }

    previousOutput = output;
  }

  if (!file.output) {
    return { status: "succeeded", output: {} };
  }
  try {
    const outputScope: InterpolationScope = { config: configScope(fileConfig), context };
    const workflowOutput = interpolateValue(file.output as JsonValue, outputScope);
    return { status: "succeeded", output: workflowOutput };
  } catch (err) {
    if (!(err instanceof InterpolationError)) throw err;
    return fail(`workflow output: ${err.message}`);
  }
}
