import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { ConfigObject, JsonValue, Worker, WorkflowFile } from "@path/schema";
import { InterpolationError, interpolateToString, interpolateValue, type InterpolationScope } from "./interpolate.js";
import { mergeConfig } from "./merge-config.js";
import { OutputParseError, parseStepOutput } from "./parse-output.js";
import type { RunObserver } from "./run-observer.js";

export interface RunOptions {
  /** The workflow's own input object (format doc §6.1); its top-level keys seed context (§6.3). */
  input?: { [key: string]: JsonValue };
  /** Operator launch-time config (CLI flags/file), overriding the top-level file's defaults (spec §3). */
  operatorConfig?: ConfigObject;
  /**
   * Every workflow file reachable from the root via `workflow` step refs, keyed by absolute path —
   * `loadWorkflowTree`'s output (#16). A `workflow` step resolves its `ref` against this map to
   * run the child file (#22); omitted when the workflow has no `workflow` steps.
   */
  files?: Map<string, WorkflowFile>;
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

// One workflow-run's identity within the run tree (#22). The root run has `parentRunId: null`
// and `nodeId: null`; a nested workflow-step's run carries its parent run's id and the `workflow`
// node's id — workflow-as-step means the child run *is* that step's run (CONTEXT invariant 2).
interface RunIdentity {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  nodeId: string | null;
}

// Everything a workflow-run needs to execute one file: the file, where it lives (for cwd defaults
// and resolving child `ref`s), the input seeding its fresh context, the effective config flowing
// in across any file boundary (operator config at the root; the parent step's effective config for
// a nested run — format doc §8: config crosses, context does not), plus the shared run tree.
interface WorkflowRunParams {
  file: WorkflowFile;
  fileDir: string;
  input: { [key: string]: JsonValue };
  incomingConfig: ConfigObject;
  identity: RunIdentity;
  files?: Map<string, WorkflowFile>;
  observer?: RunObserver;
}

// The interpolated `input` object must be a JSON object so its top-level keys can seed the child's
// context (format doc §6.3). A bare `"${context.x}"` that resolves to a string/number/array can't.
function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Executes one workflow-run: walks the file's body strictly sequentially (mvp spec §5.1),
 * running `binary` steps as child processes and `workflow` steps as nested workflow-runs (#22),
 * resolving `${}` interpolation, `input`/`publish` maps, config inheritance, and `parse: "json"`
 * at each step (spec §2 invariant 4, format §5–6, §8). Remaining node types are out of scope of
 * the walking skeleton (tickets #21–#24) and fail the run with a clear message rather than being
 * silently skipped.
 *
 * A workflow-run's own `RunObserver.runStarted`/`runFinished` calls are that run's record — for
 * the root run and, recursively, for each nested workflow-step's run, forming the run tree;
 * persistence (#18) and later logging (#19) subscribe via `observer` rather than this function
 * touching fs/db itself.
 */
async function executeWorkflowRun(params: WorkflowRunParams): Promise<RunResult> {
  const { file, fileDir, input, incomingConfig, identity, files, observer } = params;
  const { runId, rootRunId } = identity;
  const context: { [key: string]: JsonValue } = { ...input }; // format doc §6.3
  let previousOutput: JsonValue = input;

  await observer?.runStarted?.({
    runId,
    rootRunId,
    parentRunId: identity.parentRunId,
    nodeId: identity.nodeId,
    input,
  });

  // At the file boundary the incoming (operator or parent-effective) config shadows this file's
  // declared defaults key by key, nearest wins (format doc §8); worker never crosses (§7).
  const fileConfig = mergeConfig(file.config ?? {}, incomingConfig);
  const fail = async (error: string): Promise<RunResult> => {
    await observer?.runFinished?.({ runId, rootRunId, status: "failed" });
    return { status: "failed", output: previousOutput, error };
  };
  const succeed = async (output: JsonValue): Promise<RunResult> => {
    await observer?.runFinished?.({ runId, rootRunId, status: "succeeded", output });
    return { status: "succeeded", output };
  };

  for (const node of file.body) {
    if (node.type !== "binary" && node.type !== "workflow") {
      return fail(
        `step type "${node.type}" (node "${node.id}") is not supported yet — the walking skeleton runs binary and workflow steps only`,
      );
    }

    const stepConfig = mergeConfig(fileConfig, node.config);
    const scope: InterpolationScope = { config: configScope(stepConfig), context };

    let stepInput: JsonValue;
    try {
      stepInput = node.input !== undefined ? interpolateValue(node.input, scope) : previousOutput;
    } catch (err) {
      return fail(describeInterpolationError(node.id, err));
    }

    let output: JsonValue;
    if (node.type === "workflow") {
      const childResult = await runWorkflowNode(node, stepInput, {
        fileDir,
        stepConfig,
        parentRunId: runId,
        rootRunId,
        files,
        observer,
      });
      if (!childResult.success) return fail(childResult.error);
      output = childResult.output;
    } else {
      const binaryResult = await runBinaryNode(node, stepInput, {
        stepConfig,
        fileDir,
        fileWorker: file.worker,
        rootRunId,
        parentRunId: runId,
        observer,
        context,
      });
      if (!binaryResult.success) return fail(binaryResult.error);
      output = binaryResult.output;
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
      // every entry is resolved above before any of them is written to context. A nested
      // workflow-step publishes to *this* run's context only — never the child's (isolated).
      Object.assign(context, updates);
      await observer?.contextChanged?.({ runId, rootRunId, context });
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

type StepOutcome = { success: true; output: JsonValue } | { success: false; error: string };

// A `workflow` step: resolve `ref` against the loaded tree and run the child file as a nested
// workflow-run. The child starts from a fresh context seeded only by `stepInput` (context is
// isolated — CONTEXT invariant); the parent's effective config crosses the boundary but its
// worker default does not; the child's `output` map is this step's output object (format §6.4).
async function runWorkflowNode(
  node: Extract<WorkflowFile["body"][number], { type: "workflow" }>,
  stepInput: JsonValue,
  ctx: {
    fileDir: string;
    stepConfig: ConfigObject;
    parentRunId: string;
    rootRunId: string;
    files?: Map<string, WorkflowFile>;
    observer?: RunObserver;
  },
): Promise<StepOutcome> {
  if (!isJsonObject(stepInput)) {
    return {
      success: false,
      error: `workflow step "${node.id}": input must be a JSON object to seed the child's context (format doc §6.3)`,
    };
  }
  if (!ctx.files) {
    return { success: false, error: `workflow step "${node.id}": no loaded file tree to resolve ref "${node.ref}"` };
  }
  const childPath = resolve(ctx.fileDir, node.ref);
  const childFile = ctx.files.get(childPath);
  if (!childFile) {
    return { success: false, error: `workflow step "${node.id}": referenced file "${node.ref}" is not in the loaded tree` };
  }

  const childResult = await executeWorkflowRun({
    file: childFile,
    fileDir: dirname(childPath),
    input: stepInput,
    incomingConfig: ctx.stepConfig, // parent's effective config crosses the file boundary (§8)
    identity: { runId: randomUUID(), rootRunId: ctx.rootRunId, parentRunId: ctx.parentRunId, nodeId: node.id },
    files: ctx.files,
    observer: ctx.observer,
  });

  if (childResult.status === "failed") {
    return { success: false, error: `workflow step "${node.id}": ${childResult.error}` };
  }
  return { success: true, output: childResult.output };
}

// A `binary` step: resolve command/args/cwd, spawn the child process, apply `parse: "json"`, and
// emit the leaf step-run's observer lifecycle. stderr is reported (even on success) for the audit
// blob; publish/default-input threading stays with the caller.
async function runBinaryNode(
  node: Extract<WorkflowFile["body"][number], { type: "binary" }>,
  stepInput: JsonValue,
  ctx: {
    stepConfig: ConfigObject;
    fileDir: string;
    fileWorker: Worker;
    rootRunId: string;
    parentRunId: string;
    observer?: RunObserver;
    context: { [key: string]: JsonValue };
  },
): Promise<StepOutcome> {
  const { rootRunId, observer } = ctx;
  const scope: InterpolationScope = { config: configScope(ctx.stepConfig), context: ctx.context };
  const effectiveWorker: Worker = node.worker ?? ctx.fileWorker;

  let command: string;
  let args: string[];
  let cwd: string;
  try {
    command = interpolateToString(node.command, scope);
    args = (node.args ?? []).map((arg) => interpolateToString(arg, scope));
    cwd = node.cwd !== undefined ? interpolateToString(node.cwd, scope) : ctx.fileDir;
  } catch (err) {
    return { success: false, error: describeInterpolationError(node.id, err) };
  }

  const stepRunId = randomUUID();
  await observer?.stepStarted?.({
    runId: stepRunId,
    rootRunId,
    parentRunId: ctx.parentRunId,
    nodeId: node.id,
    worker: effectiveWorker,
    input: stepInput,
  });

  const result = await runBinaryStep({ id: node.id, command, args, cwd }, stepInput);
  await observer?.stepStderr?.({ runId: stepRunId, rootRunId, stderr: result.stderr });

  if (!result.success) {
    await observer?.stepFinished?.({ runId: stepRunId, rootRunId, status: "failed" });
    return { success: false, error: result.error };
  }

  let output: JsonValue = result.output;
  if (node.parse === "json") {
    try {
      output = parseStepOutput(result.output);
    } catch (err) {
      if (!(err instanceof OutputParseError)) throw err;
      await observer?.stepFinished?.({ runId: stepRunId, rootRunId, status: "failed" });
      return { success: false, error: `step "${node.id}": ${err.message}` };
    }
  }
  await observer?.stepFinished?.({ runId: stepRunId, rootRunId, status: "succeeded", output });
  return { success: true, output };
}

/**
 * Runs the top-level workflow as the root of a run tree (mvp spec §2, invariant 2): the workflow
 * is wrapped in an implicit root step whose run this call *is*. `workflow` steps in the body spawn
 * nested workflow-runs under it (#22). See `executeWorkflowRun` for the per-run walk.
 */
export async function runWorkflow(
  file: WorkflowFile,
  fileDir: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const runId = randomUUID();
  return executeWorkflowRun({
    file,
    fileDir,
    input: options.input ?? {},
    incomingConfig: options.operatorConfig ?? {},
    identity: { runId, rootRunId: runId, parentRunId: null, nodeId: null },
    files: options.files,
    observer: options.observer,
  });
}
