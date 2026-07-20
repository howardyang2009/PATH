import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { BranchNode, CheckpointNode, ConfigObject, JsonValue, WhileDoNode, Worker, WorkflowFile } from "@path/schema";
import { describeConditionFailure, evaluateCondition, type Trace } from "./condition.js";
import { InterpolationError, interpolateToString, interpolateValue, type InterpolationScope } from "./interpolate.js";
import { createAgentSdkWorker } from "./llm/agent-sdk-worker.js";
import type { LlmWorker } from "./llm/llm-worker.js";
import {
  createProcessorSemaphore,
  DEFAULT_LLM_CONCURRENCY,
  type ProcessorSemaphore,
} from "./llm/processor-semaphore.js";
import { mergeConfig } from "./merge-config.js";
import { OutputParseError, parseStepOutput } from "./parse-output.js";
import { ObserverError, type RunObserver } from "./run-observer.js";
import { collectSecrets, createMaskingObserver } from "./secret-mask.js";

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
  /**
   * Load-time diagnostics that aren't run failures — currently the short-secret warning (#20).
   * The engine has no I/O of its own, so the caller (the CLI) decides where these surface.
   */
  warn?: (message: string) => void;
  /**
   * Where `prompt` steps execute (#25). Defaults to the pinned Agent SDK worker (mvp spec §7),
   * which loads the SDK only when a prompt step actually runs; tests and any future alternate
   * worker (headless CLI, remote runner) substitute their own through this seam.
   */
  llmWorker?: LlmWorker;
  /**
   * The engine-wide cap on concurrent LLM processors (mvp spec §5.5) — default 4. One semaphore
   * covers the whole run tree, so nested workflows and nested parallels share it.
   */
  llmConcurrency?: number;
}

/**
 * The LLM execution resources one run tree shares: the worker `prompt` steps run on, and the
 * single semaphore that caps how many of its processors are live at once (mvp spec §5.5).
 */
interface LlmRuntime {
  worker: LlmWorker;
  semaphore: ProcessorSemaphore;
}

// Shaped differently from @path/schema's success/failure results: a failed run still carries
// the last-succeeded node's output (useful to a caller even on failure), so `output` is
// unconditional rather than living only in a success branch.
export interface RunResult {
  // `cancelled` (#24) applies only to a *nested* workflow-run whose leaf step the engine killed
  // because a sibling parallel branch failed (mvp spec §5.6); the root run is never cancelled.
  status: "succeeded" | "failed" | "cancelled";
  /**
   * On success: the workflow's `output` map, evaluated at successful run end (format doc §6.4) —
   * absent map = `{}`. On failure: the last node's raw output that actually ran, for debugging;
   * the workflow has no output *contract* on a failed run.
   */
  output: JsonValue;
  error?: string;
}

// The result of running one node (or a whole node sequence). A step run that a failing sibling
// cancelled reports `cancelled`; a genuine failure carries its `error` and, when a killed step run
// is the trigger, the `causeRunId` the sibling cancellations narrate (mvp spec §5.6).
type SeqOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error: string; causeRunId?: string }
  | { status: "cancelled" };

// The shared cancellation of one `parallel` block: its branches all run under `signal`, and the
// first branch to fail `trigger`s the abort so in-flight siblings are killed best-effort. The
// failing step run's id becomes `causeRunId`, which the sibling run-cancelled events point back at.
interface Cancellation {
  signal: AbortSignal;
  causeRunId: string | null;
  trigger(causeRunId: string): void;
}

// What each node in a sequence reads and writes: the `context` it sees (the run's own for the
// top-level body; a per-branch snapshot copy inside a `parallel` block, so siblings never observe
// each other's writes — mvp spec §5.3), the `signal`/`cancellation` of any enclosing parallel, and
// `onPublish` — how a landed publish is surfaced (context write-through at the top level; buffered
// for the join inside a branch).
interface NodeExecContext {
  context: { [key: string]: JsonValue };
  signal?: AbortSignal;
  cancellation?: Cancellation;
  onPublish: (updates: { [key: string]: JsonValue }) => Promise<void>;
}

type BinaryStepResult =
  | { success: true; output: string; stderr: string }
  | { success: false; error: string; stderr: string }
  // The child was killed because a sibling parallel branch failed (mvp spec §5.6): not a genuine
  // failure of this step, so it carries no error — its cause is narrated by the run-cancelled event.
  | { cancelled: true; stderr: string };

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
//
// `signal` carries best-effort cancellation (mvp spec §5.6): a parallel branch runs its steps
// under the block's abort signal, and when a sibling fails the child process is killed — reported
// as `cancelled`, distinct from a genuine non-zero exit, so no publishes from it land.
function runBinaryStep(
  step: ResolvedBinaryStep,
  input: JsonValue,
  signal?: AbortSignal,
): Promise<BinaryStepResult> {
  const { id: nodeId, command, args, cwd } = step;
  return new Promise((resolveResult) => {
    if (signal?.aborted) {
      resolveResult({ cancelled: true, stderr: "" });
      return;
    }
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (result: BinaryStepResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (signal?.aborted) {
        settle({ cancelled: true, stderr });
        return;
      }
      settle({ success: false, error: `step "${nodeId}" failed to start "${command}": ${err.message}`, stderr });
    });
    child.on("close", (code) => {
      // A kill from `signal` closes the process with a null exit code — that is a cancellation, not
      // a step failure, so it never lands as a non-zero-exit error.
      if (signal?.aborted) {
        settle({ cancelled: true, stderr });
        return;
      }
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

    // A child may exit without ever reading stdin (input is offered on stdin, not required —
    // format doc §4.2), which EPIPEs our write. Swallow stdin errors: the step's outcome is
    // decided by the exit code in "close", and a broken pipe must not crash the engine.
    child.stdin.on("error", () => {});
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
  // Shared by the entire run tree, so the processor cap spans nested runs too (mvp spec §5.5).
  llm: LlmRuntime;
  // A nested workflow-run inside a `parallel` branch inherits the block's cancellation, so its own
  // leaf steps are killed too when a sibling branch fails (mvp spec §5.6). Absent for the root run.
  signal?: AbortSignal;
  cancellation?: Cancellation;
}

type WorkflowNode = WorkflowFile["body"][number];
type StepNode = Extract<WorkflowNode, { type: "binary" | "workflow" | "prompt" }>;

// Only steps carry `config`/`input`/`publish` and execute on a worker; the control nodes around
// them are engine-evaluated logicers with no run of their own (CONTEXT invariant 1).
function isStepNode(node: WorkflowNode): node is StepNode {
  return node.type === "binary" || node.type === "workflow" || node.type === "prompt";
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
 * at each step (spec §2 invariant 4, format §5–6, §8). The control constructs — checkpoint, branch
 * (#21), parallel (#24), and while-do (#23) — are engine-evaluated in the same walk; any other node
 * type fails the run with a clear message rather than being silently skipped.
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

  // At the file boundary the incoming (operator or parent-effective) config shadows this file's
  // declared defaults key by key, nearest wins (format doc §8); worker never crosses (§7).
  const fileConfig = mergeConfig(file.config ?? {}, incomingConfig);
  const fail = async (error: string): Promise<RunResult> => {
    await observer?.runFinished?.({ runId, rootRunId, status: "failed", error });
    return { status: "failed", output: previousOutput, error };
  };
  const succeed = async (output: JsonValue): Promise<RunResult> => {
    await observer?.runFinished?.({ runId, rootRunId, status: "succeeded", output });
    return { status: "succeeded", output };
  };
  // A nested workflow-run whose leaf step a failing sibling parallel branch killed ends cancelled
  // (mvp spec §5.6) — its own terminal event, distinct from failed; no output contract.
  const cancel = async (): Promise<RunResult> => {
    await observer?.runFinished?.({ runId, rootRunId, status: "cancelled" });
    return { status: "cancelled", output: previousOutput };
  };

  // A log backend write failure fails the run audit-first (mvp spec §8.2): the logging observer
  // throws ObserverError, which we convert to a failed run here with a best-effort terminal event.
  // Any other thrown error is a bug and propagates — it is not swallowed into a failed run.
  // Each workflow-run converts its own hooks' ObserverError, so a nested run reports failed to
  // its parent and the failure travels up the run tree as an ordinary failed step.
  const failFromObserverError = async (err: ObserverError): Promise<RunResult> => {
    try {
      await observer?.runFinished?.({ runId, rootRunId, status: "failed", error: err.message });
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
    await observer?.runStarted?.({
      runId,
      rootRunId,
      parentRunId: identity.parentRunId,
      nodeId: identity.nodeId,
      input,
      worker: file.worker,
    });

    // The whole body is one node sequence walked against this run's own context; a top-level
    // publish is a context write-through (mvp spec §6). The implicit root step's default input is
    // the workflow input (format doc §6.1).
    const outcome = await runSequence(file.body, input, {
      context,
      signal: params.signal,
      cancellation: params.cancellation,
      onPublish: async () => {
        await observer?.contextChanged?.({ runId, rootRunId, context });
      },
    });
    if (outcome.status === "failed") return fail(outcome.error);
    if (outcome.status === "cancelled") return cancel();
    previousOutput = outcome.output;

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
  // A `checkpoint` node: assert its condition over the run's `context` (the branch's snapshot copy
  // inside a `parallel`) + the predecessor's `output` (spec §5.2). True → continue; false or a
  // strict evaluation error → the run stops as failed (§5.6). Transparent: forwards its
  // predecessor's output unchanged — the same object its `output` root read (§5.4). The engine has
  // no run for a checkpoint (invariant 1); the event is attributed to this run + the node's id.
  async function runCheckpointNode(node: CheckpointNode, incomingOutput: JsonValue, exec: NodeExecContext): Promise<SeqOutcome> {
    const { outcome, trace } = evaluateCondition(node.condition, { context: exec.context, output: incomingOutput });
    const passed = outcome === "true";
    await observer?.checkpointEvaluated?.({ runId, rootRunId, nodeId: node.id, passed, trace });
    if (!passed) {
      return { status: "failed", error: `checkpoint "${node.id}" failed: ${describeConditionFailure(trace)}` };
    }
    return { status: "succeeded", output: incomingOutput };
  }

  // A `branch` node: evaluate arms in declaration order, first true `when` wins; else the fallback;
  // no match and no `else` fails the run (silent fall-through hides authoring bugs — spec §5.2). A
  // condition evaluation error in an arm fails the run outright (§5.6). The taken arm's body runs
  // as a nested sequence — transparent to the block's `exec` (same context/cancellation) and seeded
  // by the block's predecessor's output (default-input chain, §5.4); its last node's output becomes
  // the block's output (§5.4).
  async function runBranchNode(node: BranchNode, incomingOutput: JsonValue, exec: NodeExecContext): Promise<SeqOutcome> {
    const roots = { context: exec.context, output: incomingOutput };
    const traces: Trace[] = [];
    for (const [index, arm] of node.arms.entries()) {
      const { outcome, trace } = evaluateCondition(arm.when, roots);
      traces.push(trace);
      if (outcome === "error") {
        return { status: "failed", error: `branch "${node.id}" arm ${index}: condition evaluation error: ${describeConditionFailure(trace)}` };
      }
      if (outcome === "true") {
        await observer?.branchTaken?.({ runId, rootRunId, nodeId: node.id, arm: index, trace });
        return runSequence(arm.body, incomingOutput, exec);
      }
    }
    if (node.else) {
      await observer?.branchTaken?.({ runId, rootRunId, nodeId: node.id, arm: "else", trace: null });
      return runSequence(node.else, incomingOutput, exec);
    }
    await observer?.branchNoMatch?.({ runId, rootRunId, nodeId: node.id, traces });
    return { status: "failed", error: `branch "${node.id}": no arm matched and there is no else (spec §5.2)` };
  }

  // A `while-do` node: check the condition before every iteration against the run's `context` + the
  // output that seeds the next iteration's first node (spec §5.2, §5.4). Zero iterations is a normal,
  // transparent exit — the block forwards its predecessor's output unchanged. Each iteration's body
  // runs as a nested sequence seeded by the previous iteration's last node's output (the cross-
  // iteration default-input chain, §5.4); iteration 1 is seeded by the block predecessor's output.
  // The block output is the final executed iteration's last node's output. If the condition is still
  // true after `max_iterations` completed iterations the run fails (§5.2/§5.6); a condition
  // evaluation error fails the run outright (§5.6).
  async function runWhileDoNode(node: WhileDoNode, incomingOutput: JsonValue, exec: NodeExecContext): Promise<SeqOutcome> {
    let maxIterations: number;
    if (typeof node.max_iterations === "number") {
      maxIterations = node.max_iterations;
    } else {
      const scope: InterpolationScope = { config: configScope(fileConfig), context: exec.context };
      let resolved: string;
      try {
        resolved = interpolateToString(node.max_iterations, scope);
      } catch (err) {
        return { status: "failed", error: describeInterpolationError(node.id, err) };
      }
      const parsed = Number(resolved);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { status: "failed", error: `while-do "${node.id}": max_iterations resolved to "${resolved}", which is not a positive integer` };
      }
      maxIterations = parsed;
    }

    let iterationOutput = incomingOutput;
    let iterations = 0; // completed iterations
    for (;;) {
      const { outcome, trace } = evaluateCondition(node.condition, { context: exec.context, output: iterationOutput });
      if (outcome === "error") {
        return { status: "failed", error: `while-do "${node.id}": condition evaluation error: ${describeConditionFailure(trace)}` };
      }
      if (outcome === "false") {
        await observer?.loopExited?.({ runId, rootRunId, nodeId: node.id, reason: "condition-false", iterations, trace });
        return { status: "succeeded", output: iterationOutput };
      }
      // Condition true, but the cap has already been reached: the run fails (post-loop nodes may
      // assume the condition resolved false, so an exhausted loop is an authoring error, not an exit).
      if (iterations >= maxIterations) {
        await observer?.loopExited?.({ runId, rootRunId, nodeId: node.id, reason: "max-iterations-exceeded", iterations, trace });
        return { status: "failed", error: `while-do "${node.id}": condition still true after max_iterations (${maxIterations}) — the run fails (spec §5.2)` };
      }
      iterations += 1;
      await observer?.iterationStarted?.({ runId, rootRunId, nodeId: node.id, iteration: iterations, trace });
      const bodyOutcome = await runSequence(node.body, iterationOutput, exec);
      if (bodyOutcome.status !== "succeeded") return bodyOutcome;
      iterationOutput = bodyOutcome.output;
    }
  }

  /**
   * Walks a node sequence strictly in order (mvp spec §5.1), threading the default-input chain: a
   * node with no `input` reads its predecessor's output (`seedInput` for the first node — the
   * block's predecessor's output, format doc §6.1). Each step's `publish` lands atomically on
   * success before the next node starts (§5.3), applied to `exec.context` and surfaced via
   * `exec.onPublish`. Returns the last node's output, or the first non-success outcome (fail-fast).
   *
   * This one function serves both the top-level body and each `parallel` branch — the block is
   * transparent to one uniform chain (§5.4).
   */
  async function runSequence(
    nodes: WorkflowFile["body"],
    seedInput: JsonValue,
    exec: NodeExecContext,
  ): Promise<SeqOutcome> {
    let previous: JsonValue = seedInput;

    for (const node of nodes) {
      const stepConfig = isStepNode(node) ? mergeConfig(fileConfig, node.config) : undefined;

      let outcome: SeqOutcome;
      if (isStepNode(node)) {
        const scope: InterpolationScope = { config: configScope(stepConfig!), context: exec.context };
        let stepInput: JsonValue;
        try {
          stepInput = node.input !== undefined ? interpolateValue(node.input, scope) : previous;
        } catch (err) {
          return { status: "failed", error: describeInterpolationError(node.id, err) };
        }
        const leafCtx = {
          stepConfig: stepConfig!,
          fileDir,
          fileWorker: file.worker,
          rootRunId,
          parentRunId: runId,
          observer,
          context: exec.context,
          signal: exec.signal,
          cancellation: exec.cancellation,
        };
        if (node.type === "workflow") {
          outcome = await runWorkflowNode(node, stepInput, {
            fileDir,
            stepConfig: stepConfig!,
            parentRunId: runId,
            rootRunId,
            files,
            observer,
            llm: params.llm,
            signal: exec.signal,
            cancellation: exec.cancellation,
          });
        } else if (node.type === "prompt") {
          outcome = await runPromptNode(node, stepInput, { ...leafCtx, llm: params.llm });
        } else {
          outcome = await runBinaryNode(node, stepInput, leafCtx);
        }
      } else if (node.type === "parallel") {
        // Every branch's first node defaults to the block's predecessor's output (§5.4).
        outcome = await runParallelNode(node, previous, exec);
      } else if (node.type === "checkpoint") {
        outcome = await runCheckpointNode(node, previous, exec);
      } else if (node.type === "branch") {
        outcome = await runBranchNode(node, previous, exec);
      } else if (node.type === "while-do") {
        outcome = await runWhileDoNode(node, previous, exec);
      } else {
        // Unreachable for the format as it stands — every declared node type is walked above. The
        // guard survives for a node type that lands in the format before the engine walks it: it
        // must fail the run loudly rather than be silently skipped.
        const unknown = node as { type: string; id: string };
        return {
          status: "failed",
          error: `node type "${unknown.type}" (node "${unknown.id}") is not supported by this engine`,
        };
      }

      if (outcome.status !== "succeeded") return outcome;
      const output = outcome.output;

      if (isStepNode(node) && node.publish) {
        const publishScope: InterpolationScope = { config: configScope(stepConfig!), context: exec.context, output };
        const updates: { [key: string]: JsonValue } = {};
        try {
          for (const [key, expr] of Object.entries(node.publish)) {
            updates[key] = interpolateValue(expr, publishScope);
          }
        } catch (err) {
          return { status: "failed", error: describeInterpolationError(node.id, err) };
        }
        // Every entry resolves before any is written, so the publish lands atomically (§5.3). A
        // nested workflow-step publishes to *this* run's context only — never the child's (isolated).
        Object.assign(exec.context, updates);
        await exec.onPublish(updates);
      }

      previous = output;
    }

    return { status: "succeeded", output: previous };
  }

  /**
   * Runs a `parallel` block with the `collect` join (mvp spec §5.2–5.4, §5.6): every branch runs
   * concurrently against its own snapshot of context taken at block entry (siblings never see each
   * other's writes), its publishes buffer and land — at the join, in branch declaration order —
   * only if *all* branches succeed. A failing branch fails the block and cancels in-flight siblings
   * best-effort; no publishes from a failed or cancelled branch land. The block output is
   * `{ "<branch-id>": <that branch's last node's output> }`, deterministic regardless of completion
   * order.
   */
  async function runParallelNode(
    node: Extract<WorkflowFile["body"][number], { type: "parallel" }>,
    seedInput: JsonValue,
    exec: NodeExecContext,
  ): Promise<SeqOutcome> {
    const controller = new AbortController();
    // A nested parallel inherits its enclosing block's cancellation: if the outer block aborts, this
    // one aborts too, so this block's own in-flight steps are killed as well.
    const outerSignal = exec.signal;
    const onOuterAbort = () => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
    }

    let causeRunId: string | null = exec.cancellation?.causeRunId ?? null;
    const cancellation: Cancellation = {
      signal: controller.signal,
      get causeRunId() {
        return causeRunId;
      },
      trigger(cause: string) {
        if (causeRunId === null) causeRunId = cause; // first failing sibling wins
        controller.abort();
      },
    };

    const branchResults = await Promise.all(
      node.branches.map(async (branch) => {
        // Each branch runs against a snapshot copy of context (§5.3): its publishes go to the copy
        // (so later nodes in the same branch see them) and buffer for the join — never touching the
        // parent context until the join lands them.
        const branchContext: { [key: string]: JsonValue } = { ...exec.context };
        const buffer: { [key: string]: JsonValue } = {};
        const outcome = await runSequence(branch.body, seedInput, {
          context: branchContext,
          signal: controller.signal,
          cancellation,
          onPublish: async (updates) => {
            Object.assign(buffer, updates);
          },
        });
        if (outcome.status === "failed") {
          cancellation.trigger(outcome.causeRunId ?? runId); // cancel in-flight siblings best-effort
        }
        return { branch, outcome, buffer };
      }),
    );

    if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);

    // A failing branch fails the block (and thus the run); no publishes land. Report the
    // first-declared failure for determinism.
    for (const { branch, outcome } of branchResults) {
      if (outcome.status === "failed") {
        return {
          status: "failed",
          error: `parallel "${node.id}", branch "${branch.id}": ${outcome.error}`,
        };
      }
    }
    // No local failure but a cancelled branch means the enclosing block aborted us: propagate.
    if (branchResults.some((r) => r.outcome.status === "cancelled")) {
      return { status: "cancelled" };
    }

    // All branches succeeded: land their buffered publishes at the join, in branch declaration
    // order (§5.3). Duplicate keys across siblings are already a load-time error, so no key clashes.
    const landed: { [key: string]: JsonValue } = {};
    const publishedKeys: string[] = [];
    for (const { buffer } of branchResults) {
      for (const [key, value] of Object.entries(buffer)) {
        landed[key] = value;
        publishedKeys.push(key);
      }
    }
    Object.assign(exec.context, landed);
    if (publishedKeys.length > 0) await exec.onPublish(landed);
    await observer?.joinApplied?.({
      runId,
      rootRunId,
      nodeId: node.id,
      branches: branchResults.map((r) => r.branch.id),
      publishedKeys,
    });

    // Collect output: keyed by branch id in declaration order, deterministic regardless of
    // completion order and dot-path addressable (§5.4).
    const output: { [key: string]: JsonValue } = {};
    for (const { branch, outcome } of branchResults) {
      output[branch.id] = outcome.status === "succeeded" ? outcome.output : null;
    }
    return { status: "succeeded", output };
  }
}

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
    // Shared down the whole run tree so the child's prompt steps queue on the same cap (§5.5).
    llm: LlmRuntime;
    // Inherited from an enclosing `parallel` branch (#24): a sibling failure kills this nested
    // run's own leaf steps too (mvp spec §5.6), ending it `cancelled`.
    signal?: AbortSignal;
    cancellation?: Cancellation;
  },
): Promise<SeqOutcome> {
  if (!isJsonObject(stepInput)) {
    return {
      status: "failed",
      error: `workflow step "${node.id}": input must be a JSON object to seed the child's context (format doc §6.3)`,
    };
  }
  if (!ctx.files) {
    return { status: "failed", error: `workflow step "${node.id}": no loaded file tree to resolve ref "${node.ref}"` };
  }
  const childPath = resolve(ctx.fileDir, node.ref);
  const childFile = ctx.files.get(childPath);
  if (!childFile) {
    return { status: "failed", error: `workflow step "${node.id}": referenced file "${node.ref}" is not in the loaded tree` };
  }

  const childResult = await executeWorkflowRun({
    file: childFile,
    fileDir: dirname(childPath),
    input: stepInput,
    incomingConfig: ctx.stepConfig, // parent's effective config crosses the file boundary (§8)
    identity: { runId: randomUUID(), rootRunId: ctx.rootRunId, parentRunId: ctx.parentRunId, nodeId: node.id },
    files: ctx.files,
    observer: ctx.observer,
    llm: ctx.llm,
    signal: ctx.signal,
    cancellation: ctx.cancellation,
  });

  if (childResult.status === "cancelled") return { status: "cancelled" };
  if (childResult.status === "failed") {
    return { status: "failed", error: `workflow step "${node.id}": ${childResult.error}` };
  }
  return { status: "succeeded", output: childResult.output };
}

// Everything a leaf step run needs from its enclosing workflow-run: the effective config and file
// worker it inherits, its place in the run tree, the context it interpolates against, and any
// enclosing `parallel` block's cancellation (#24).
interface LeafStepContext {
  stepConfig: ConfigObject;
  fileDir: string;
  fileWorker: Worker;
  rootRunId: string;
  parentRunId: string;
  observer?: RunObserver;
  context: { [key: string]: JsonValue };
  signal?: AbortSignal;
  cancellation?: Cancellation;
}

// The tail every leaf step shares once its worker has produced a raw string output: apply
// `parse: "json"` (format doc §6.5) and emit the terminal `stepFinished`. A parse failure fails
// the step with its own run as the cause; otherwise the (parsed or raw) output succeeds. Keeps the
// parse/finish shape identical across binary and prompt steps so the two can't drift.
async function finishLeafStep(
  observer: RunObserver | undefined,
  ids: { runId: string; rootRunId: string },
  node: { id: string; parse?: "text" | "json" },
  rawOutput: string,
): Promise<SeqOutcome> {
  let output: JsonValue = rawOutput;
  if (node.parse === "json") {
    try {
      output = parseStepOutput(rawOutput);
    } catch (err) {
      if (!(err instanceof OutputParseError)) throw err;
      const parseError = `step "${node.id}": ${err.message}`;
      await observer?.stepFinished?.({ runId: ids.runId, rootRunId: ids.rootRunId, status: "failed", error: parseError });
      return { status: "failed", error: parseError, causeRunId: ids.runId };
    }
  }
  await observer?.stepFinished?.({ runId: ids.runId, rootRunId: ids.rootRunId, status: "succeeded", output });
  return { status: "succeeded", output };
}

/**
 * A `prompt` step: run it on the LLM worker as one **fresh processor**, torn down when the step
 * completes (mvp spec §5.5) — no session reuse, so the step reads exactly what its `input` map
 * built. The processor slot comes from the engine-wide semaphore first, so a step that cannot get
 * one simply waits (and its run row only starts once it is really running); binary steps are
 * uncapped and never queue behind it.
 *
 * `usage` and `estimated_cost_usd` are reported here, on this leaf run, for both a succeeded and a
 * failed processor — a step that died mid-conversation still spent tokens (§5.7, §7).
 */
async function runPromptNode(
  node: Extract<WorkflowNode, { type: "prompt" }>,
  stepInput: JsonValue,
  ctx: LeafStepContext & { llm: LlmRuntime },
): Promise<SeqOutcome> {
  const { rootRunId, observer } = ctx;
  const scope: InterpolationScope = { config: configScope(ctx.stepConfig), context: ctx.context };
  const effectiveWorker: Worker = node.worker ?? ctx.fileWorker;

  // Worker is a *binding*, not a suggestion: a prompt step bound to the local engine has no
  // processor to run on, and silently treating it as an LLM step would hide the authoring bug.
  if (effectiveWorker.type !== "llm") {
    return {
      status: "failed",
      error: `prompt step "${node.id}": needs an llm worker, but its effective worker is "${effectiveWorker.type}" (format doc §7)`,
    };
  }

  let model: string;
  let prompt: string;
  try {
    model = interpolateToString(effectiveWorker.model, scope); // worker values are interpolable (§7)
    prompt = interpolateToString(node.prompt, scope);
  } catch (err) {
    return { status: "failed", error: describeInterpolationError(node.id, err) };
  }

  const release = await ctx.llm.semaphore.acquire();
  let result;
  try {
    const stepRunId = randomUUID();
    await observer?.stepStarted?.({
      runId: stepRunId,
      rootRunId,
      parentRunId: ctx.parentRunId,
      nodeId: node.id,
      stepType: node.type,
      worker: effectiveWorker,
      input: stepInput,
    });

    result = await ctx.llm.worker.runPrompt({
      nodeId: node.id,
      model,
      prompt,
      input: stepInput,
      // The `options` bag is worker-side: MCP servers and skills pass straight through, and no
      // engine code interprets them (mvp spec §7).
      options: effectiveWorker.options,
      cwd: ctx.fileDir,
      signal: ctx.signal,
    });

    if (result.status === "cancelled") {
      // A failing sibling parallel branch killed this processor (mvp spec §5.6) — not a failure of
      // this step, so no publish from it lands and the cause is narrated separately.
      await observer?.runCancelled?.({
        runId: stepRunId,
        rootRunId,
        nodeId: node.id,
        causeRunId: ctx.cancellation?.causeRunId ?? ctx.parentRunId,
      });
      await observer?.stepFinished?.({ runId: stepRunId, rootRunId, status: "cancelled" });
      return { status: "cancelled" };
    }

    // Leaf-only (§5.7): recorded on this run, never rolled up — subtree figures are a read-time SUM.
    if (result.usage !== null || result.estimatedCostUsd !== null) {
      await observer?.stepUsage?.({
        runId: stepRunId,
        rootRunId,
        usage: result.usage,
        estimatedCostUsd: result.estimatedCostUsd,
      });
    }

    if (result.status === "failed") {
      await observer?.stepFinished?.({ runId: stepRunId, rootRunId, status: "failed", error: result.error });
      return { status: "failed", error: result.error, causeRunId: stepRunId };
    }

    return finishLeafStep(observer, { runId: stepRunId, rootRunId }, node, result.output);
  } finally {
    // The processor is gone by now either way; holding its slot any longer would shrink the cap.
    release();
  }
}

// A `binary` step: resolve command/args/cwd, spawn the child process, apply `parse: "json"`, and
// emit the leaf step-run's observer lifecycle. stderr is reported (even on success) for the audit
// blob; publish/default-input threading stays with the caller.
async function runBinaryNode(
  node: Extract<WorkflowNode, { type: "binary" }>,
  stepInput: JsonValue,
  // `signal` (from an enclosing `parallel` block, #24) kills the child on a sibling failure, and
  // `cancellation.causeRunId` is the failing sibling the run-cancelled event points at.
  ctx: LeafStepContext,
): Promise<SeqOutcome> {
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
    return { status: "failed", error: describeInterpolationError(node.id, err) };
  }

  const stepRunId = randomUUID();
  await observer?.stepStarted?.({
    runId: stepRunId,
    rootRunId,
    parentRunId: ctx.parentRunId,
    nodeId: node.id,
    stepType: node.type,
    worker: effectiveWorker,
    input: stepInput,
  });

  const result = await runBinaryStep({ id: node.id, command, args, cwd }, stepInput, ctx.signal);
  await observer?.stepStderr?.({ runId: stepRunId, rootRunId, stderr: result.stderr });

  if ("cancelled" in result) {
    // A failing sibling parallel branch killed this step (mvp spec §5.6): narrate the cancellation
    // (its cause the failing sibling run) and end the run `cancelled`, not `failed`. No publish lands.
    await observer?.runCancelled?.({
      runId: stepRunId,
      rootRunId,
      nodeId: node.id,
      causeRunId: ctx.cancellation?.causeRunId ?? ctx.parentRunId,
    });
    await observer?.stepFinished?.({ runId: stepRunId, rootRunId, status: "cancelled" });
    return { status: "cancelled" };
  }

  if (!result.success) {
    await observer?.stepFinished?.({ runId: stepRunId, rootRunId, status: "failed", error: result.error });
    return { status: "failed", error: result.error, causeRunId: stepRunId };
  }

  return finishLeafStep(observer, { runId: stepRunId, rootRunId }, node, result.output);
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

  // Collect every `$secret` value in effective config once at run start (mvp spec §8.3, #20) and
  // wrap the observer so the whole run tree's persisted artifacts are scrubbed at the seam — the
  // interpolated values handed to workers stay real, only what crosses into persistence is masked.
  const masker = collectSecrets(collectRunSecrets(file, options));
  for (const warning of masker.warnings) options.warn?.(warning);
  const observer =
    options.observer && !masker.isEmpty ? createMaskingObserver(masker, options.observer) : options.observer;

  return executeWorkflowRun({
    file,
    fileDir,
    input: options.input ?? {},
    incomingConfig: options.operatorConfig ?? {},
    identity: { runId, rootRunId: runId, parentRunId: null, nodeId: null },
    files: options.files,
    observer,
    // One worker and one semaphore for the whole run tree: the cap is engine-wide, spanning
    // nested workflows and nested parallels alike (mvp spec §5.5).
    llm: {
      worker: options.llmWorker ?? createAgentSdkWorker(),
      semaphore: createProcessorSemaphore(options.llmConcurrency ?? DEFAULT_LLM_CONCURRENCY),
    },
  });
}

// Every config object a run's secrets can ride in on: operator overrides first (they win a token
// key on a duplicated value — nearest config), then each reachable file's declared config and each
// of its steps' configs, since secrecy rides a value through inheritance to any of them.
function collectRunSecrets(rootFile: WorkflowFile, options: RunOptions): ConfigObject[] {
  const configs: ConfigObject[] = [];
  if (options.operatorConfig) configs.push(options.operatorConfig);

  const files = options.files ? [...options.files.values()] : [rootFile];
  if (!files.includes(rootFile)) files.push(rootFile);
  for (const file of files) {
    if (file.config) configs.push(file.config);
    for (const node of file.body) {
      if ("config" in node && node.config) configs.push(node.config);
    }
  }
  return configs;
}
