import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ConfigObject, JsonValue, Worker, WorkflowFile } from "@path/schema";
import { InterpolationError, interpolateToString, interpolateValue, type InterpolationScope } from "./interpolate.js";
import { mergeConfig } from "./merge-config.js";
import { OutputParseError, parseStepOutput } from "./parse-output.js";
import { ObserverError, type RunObserver } from "./run-observer.js";

export interface RunOptions {
  /** The workflow's own input object (format doc §6.1); its top-level keys seed context (§6.3). */
  input?: { [key: string]: JsonValue };
  /** Operator launch-time config (CLI flags/file), overriding the top-level file's defaults (spec §3). */
  operatorConfig?: ConfigObject;
  /** Lifecycle hooks for persistence (#18) and later logging (#19) — see run-observer.ts. */
  observer?: RunObserver;
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

type BinaryStepResult =
  | { success: true; output: string; stderr: string }
  | { success: false; error: string; stderr: string };

// The step's `command`/`args`/`cwd` after interpolation — they travel together everywhere a
// binary step actually runs, so runBinaryStep takes this instead of three loose parameters.
interface ResolvedBinaryStep {
  id: string;
  command: string;
  args: string[];
  cwd: string;
}

// I/O convention per format doc §4.2: input object on stdin (raw if a string, else its JSON
// serialization), captured stdout is the output, non-zero exit fails the step. stderr is always
// returned (even on success) so the caller can hand it to RunObserver.stepStderr for the audit
// blob (format doc §4.2: captured, secret-scrubbed later, never passed downstream).
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
      settle({ success: false, error: `step "${nodeId}" failed to start "${command}": ${err.message}`, stderr });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().slice(-500);
        settle({
          success: false,
          error: `step "${nodeId}" exited with code ${code}${tail ? `: ${tail}` : ""}`,
          stderr,
        });
        return;
      }
      settle({ success: true, output: stdout, stderr });
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
 * invariant 2) whose run this body walk *is* — its `RunObserver.runStarted`/`runFinished` calls
 * are that run's record; persistence (#18) and later logging (#19) subscribe via `options.observer`
 * rather than this function touching fs/db itself.
 */
export async function runWorkflow(
  file: WorkflowFile,
  fileDir: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const input = options.input ?? {};
  const context: { [key: string]: JsonValue } = { ...input }; // format doc §6.3
  let previousOutput: JsonValue = input;

  const observer = options.observer;
  const runId = randomUUID();

  const fileConfig = mergeConfig(file.config ?? {}, options.operatorConfig);
  const fail = async (error: string): Promise<RunResult> => {
    await observer?.runFinished?.({ runId, status: "failed", error });
    return { status: "failed", output: previousOutput, error };
  };
  const succeed = async (output: JsonValue): Promise<RunResult> => {
    await observer?.runFinished?.({ runId, status: "succeeded", output });
    return { status: "succeeded", output };
  };

  // A log backend write failure fails the run audit-first (mvp spec §8.2): the logging observer
  // throws ObserverError, which we convert to a failed run here with a best-effort terminal event.
  // Any other thrown error is a bug and propagates — it is not swallowed into a failed run.
  const failFromObserverError = async (err: ObserverError): Promise<RunResult> => {
    try {
      await observer?.runFinished?.({ runId, status: "failed", error: err.message });
    } catch {
      // audit is already compromised; the best we can do is still report the run as failed
    }
    return { status: "failed", output: previousOutput, error: err.message };
  };

  try {
    return await runBody();
  } catch (err) {
    if (err instanceof ObserverError) return failFromObserverError(err);
    throw err;
  }

  async function runBody(): Promise<RunResult> {
    await observer?.runStarted?.({ runId, input, worker: file.worker });

    for (const node of file.body) {
      if (node.type !== "binary") {
        return fail(
          `step type "${node.type}" (node "${node.id}") is not supported yet — the walking skeleton runs binary steps only`,
        );
      }

      const stepConfig = mergeConfig(fileConfig, node.config);
      const scope: InterpolationScope = { config: configScope(stepConfig), context };
      const effectiveWorker: Worker = node.worker ?? file.worker;

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

      const stepRunId = randomUUID();
      await observer?.stepStarted?.({
        runId: stepRunId,
        parentRunId: runId,
        nodeId: node.id,
        stepType: node.type,
        worker: effectiveWorker,
        input: stepInput,
      });

      const result = await runBinaryStep({ id: node.id, command, args, cwd }, stepInput);
      await observer?.stepStderr?.({ runId: stepRunId, stderr: result.stderr });

      if (!result.success) {
        await observer?.stepFinished?.({ runId: stepRunId, status: "failed", error: result.error });
        return fail(result.error);
      }

      let output: JsonValue = result.output;
      if (node.parse === "json") {
        try {
          output = parseStepOutput(result.output);
        } catch (err) {
          if (!(err instanceof OutputParseError)) throw err;
          const parseError = `step "${node.id}": ${err.message}`;
          await observer?.stepFinished?.({ runId: stepRunId, status: "failed", error: parseError });
          return fail(parseError);
        }
      }
      await observer?.stepFinished?.({ runId: stepRunId, status: "succeeded", output });

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
        await observer?.contextChanged?.({ runId, context });
      }

      previousOutput = output;
    }

    if (!file.output) {
      return succeed({});
    }
    try {
      const outputScope: InterpolationScope = { config: configScope(fileConfig), context };
      const workflowOutput = interpolateValue(file.output as JsonValue, outputScope);
      return succeed(workflowOutput);
    } catch (err) {
      if (!(err instanceof InterpolationError)) throw err;
      return fail(`workflow output: ${err.message}`);
    }
  }
}
