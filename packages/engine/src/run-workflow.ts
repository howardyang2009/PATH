import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { BranchNode, CheckpointNode, ConfigObject, JsonValue, WhileDoNode, Worker, WorkflowFile } from "@path/schema";
import { runBinaryStep } from "./binary-worker.js";
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
import { type Observation, ObserverError, type RunObserver } from "./run-observer.js";
import { collectSecrets, maskObservation } from "./secret-mask.js";

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
  /** The audit seam: one observer receiving every observation of this run tree (see run-observer.ts). */
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
  /**
   * External abort (#52): the way an operator stops this root run in flight. Aborting it kills the
   * in-flight leaf steps of the whole run tree best-effort — a binary step's child process, an LLM
   * step's processor — and the root run ends `cancelled` rather than dying mid-step or being left as
   * a lying `running` row. A signal that is already aborted when `runWorkflow` is called cancels the
   * run before its first step.
   *
   * Best-effort, not guaranteed (mvp spec §5.6): cancellation asks, and the engine holds no deadline
   * and no force path. Cancellation is per **root run** — there is no per-run controller registry.
   */
  signal?: AbortSignal;
}

/**
 * The engine's single emit choke point, threaded to every node of the run tree in place of the
 * observer itself (#62). Two things are guaranteed here and therefore nowhere else:
 *
 * - **Secrets are masked** (mvp spec §8.3) before anything crosses the seam. No caller has to apply
 *   a wrapper, so no caller can forget to — and no wrapper can cover part of the union.
 * - **The absent observer is handled once.** A run with nothing observing it emits into a no-op, so
 *   the 24 call sites downstream are plain `await emit(...)` rather than optional chains.
 */
export type Emit = (o: Observation) => Promise<void>;

/**
 * The LLM execution resources one run tree shares: the worker `prompt` steps run on, and the
 * single semaphore that caps how many of its processors are live at once (mvp spec §5.5).
 */
export interface LlmRuntime {
  worker: LlmWorker;
  semaphore: ProcessorSemaphore;
}

// Shaped differently from @path/schema's success/failure results: a failed run still carries
// the last-succeeded node's output (useful to a caller even on failure), so `output` is
// unconditional rather than living only in a success branch.
export interface RunResult {
  // `cancelled` is a run whose leaf steps the engine killed best-effort (mvp spec §5.6): because a
  // sibling parallel branch failed (#24), or because an operator aborted `RunOptions.signal` (#52) —
  // which any run in the tree, the root included, may end on.
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
export type SeqOutcome =
  | { status: "succeeded"; output: JsonValue }
  | { status: "failed"; error: string; causeRunId?: string }
  | { status: "cancelled" };

// The shared cancellation of one `parallel` block: its branches all run under `signal`, and the
// first branch to fail `trigger`s the abort so in-flight siblings are killed best-effort. The
// failing step run's id becomes `causeRunId`, which the sibling run-cancelled events point back at.
// `causeRunId` stays null when nothing inside the run tree failed — the abort then came from outside
// it, i.e. an operator cancelling the root run (#52).
export interface Cancellation {
  signal: AbortSignal;
  causeRunId: string | null;
  trigger(causeRunId: string): void;
}

// What each node in a sequence reads and writes: the `context` it sees (the run's own for the
// top-level body; a per-branch snapshot copy inside a `parallel` block, so siblings never observe
// each other's writes — mvp spec §5.3), the `signal`/`cancellation` of any enclosing parallel, and
// `onPublish` — how a landed publish is surfaced (context write-through at the top level; buffered
// for the join inside a branch).
export interface NodeExecContext {
  context: { [key: string]: JsonValue };
  signal?: AbortSignal;
  cancellation?: Cancellation;
  onPublish: (updates: { [key: string]: JsonValue }) => Promise<void>;
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
export interface RunIdentity {
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
  emit: Emit;
  // Shared by the entire run tree, so the processor cap spans nested runs too (mvp spec §5.5).
  llm: LlmRuntime;
  // A nested workflow-run inside a `parallel` branch inherits the block's cancellation, so its own
  // leaf steps are killed too when a sibling branch fails (mvp spec §5.6). The root run carries the
  // operator's own `RunOptions.signal` when there is one (#52) — with no `cancellation`, since a run
  // it kills has no cause run inside the tree.
  signal?: AbortSignal;
  cancellation?: Cancellation;
}

/**
 * Everything that is fixed for the life of one workflow-run, threaded to every node walker.
 *
 * The mutable half — the context a sequence writes to, its cancellation, how a publish lands — is
 * `NodeExecContext`, and varies per sequence (a `parallel` branch gets its own snapshot copy). This
 * is the other half: the file being run, its effective config, who this run is, and the shared
 * resources of the run tree.
 *
 * Splitting the two is what lets the walkers live at module scope (#76). They used to be nested in
 * a 392-line closure and were reached only through a full `runWorkflow`, so the branch, loop and
 * join semantics that carry the spec had no seam a test could aim at. Four overlapping context bags
 * became these two.
 */
export interface RunContext {
  file: WorkflowFile;
  /** The workflow file's own directory: binary `cwd` defaults and nested `ref`s resolve against it. */
  fileDir: string;
  /** This file's declared config with the incoming config shadowing it, nearest wins (format §8). */
  fileConfig: ConfigObject;
  identity: RunIdentity;
  emit: Emit;
  files?: Map<string, WorkflowFile>;
  /** Shared by the whole run tree, so the processor cap spans nested runs too (mvp spec §5.5). */
  llm: LlmRuntime;
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
  const { file, fileDir, input, incomingConfig, identity, files, emit } = params;
  const { runId, rootRunId } = identity;
  const context: { [key: string]: JsonValue } = { ...input }; // format doc §6.3
  let previousOutput: JsonValue = input;

  // At the file boundary the incoming (operator or parent-effective) config shadows this file's
  // declared defaults key by key, nearest wins (format doc §8); worker never crosses (§7).
  const fileConfig = mergeConfig(file.config ?? {}, incomingConfig);
  const run: RunContext = { file, fileDir, fileConfig, identity, emit, files, llm: params.llm };
  const fail = async (error: string): Promise<RunResult> => {
    await emit({ type: "run-finished", runId, rootRunId, status: "failed", error });
    return { status: "failed", output: previousOutput, error };
  };
  const succeed = async (output: JsonValue): Promise<RunResult> => {
    await emit({ type: "run-finished", runId, rootRunId, status: "succeeded", output });
    return { status: "succeeded", output };
  };
  // A workflow-run whose leaf step the engine killed — by a failing sibling parallel branch (#24) or
  // by an operator's abort (#52) — ends cancelled (mvp spec §5.6): its own terminal event, distinct
  // from failed; no output contract. For the root run this is the `step-finished` of the implicit
  // root step, so its row lands `cancelled` and the log backends close on it like any other end.
  const cancel = async (): Promise<RunResult> => {
    await emit({ type: "run-finished", runId, rootRunId, status: "cancelled" });
    return { status: "cancelled", output: previousOutput };
  };

  // A log backend write failure fails the run audit-first (mvp spec §8.2): the logging observer
  // throws ObserverError, which we convert to a failed run here with a best-effort terminal event.
  // Any other thrown error is a bug and propagates — it is not swallowed into a failed run.
  // Each workflow-run converts its own hooks' ObserverError, so a nested run reports failed to
  // its parent and the failure travels up the run tree as an ordinary failed step.
  const failFromObserverError = async (err: ObserverError): Promise<RunResult> => {
    try {
      await emit({ type: "run-finished", runId, rootRunId, status: "failed", error: err.message });
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
    await emit({ type: "run-started",
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
    const outcome = await runSequence(run, file.body, input, {
      context,
      signal: params.signal,
      cancellation: params.cancellation,
      onPublish: async () => {
        await emit({ type: "context-changed", runId, rootRunId, context });
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
}

// A `workflow` step: resolve `ref` against the loaded tree and run the child file as a nested
// workflow-run. The child starts from a fresh context seeded only by `stepInput` (context is
// isolated — CONTEXT invariant); the parent's effective config crosses the boundary but its
// worker default does not; the child's `output` map is this step's output object (format §6.4).
async function runWorkflowNode(
  node: Extract<WorkflowFile["body"][number], { type: "workflow" }>,
  stepInput: JsonValue,
  ctx: StepContext,
): Promise<SeqOutcome> {
  if (!isJsonObject(stepInput)) {
    return {
      status: "failed",
      error: `workflow step "${node.id}": input must be a JSON object to seed the child's context (format doc §6.3)`,
    };
  }
  if (!ctx.run.files) {
    return { status: "failed", error: `workflow step "${node.id}": no loaded file tree to resolve ref "${node.ref}"` };
  }
  const childPath = resolve(ctx.run.fileDir, node.ref);
  const childFile = ctx.run.files.get(childPath);
  if (!childFile) {
    return { status: "failed", error: `workflow step "${node.id}": referenced file "${node.ref}" is not in the loaded tree` };
  }

  const childResult = await executeWorkflowRun({
    file: childFile,
    fileDir: dirname(childPath),
    input: stepInput,
    incomingConfig: ctx.stepConfig, // parent's effective config crosses the file boundary (§8)
    identity: { runId: randomUUID(), rootRunId: ctx.run.identity.rootRunId, parentRunId: ctx.run.identity.runId, nodeId: node.id },
    files: ctx.run.files,
    emit: ctx.run.emit,
    llm: ctx.run.llm,
    signal: ctx.exec.signal,
    cancellation: ctx.exec.cancellation,
  });

  if (childResult.status === "cancelled") return { status: "cancelled" };
  if (childResult.status === "failed") {
    return { status: "failed", error: `workflow step "${node.id}": ${childResult.error}` };
  }
  return { status: "succeeded", output: childResult.output };
}

// Everything a leaf step run needs from its enclosing workflow-run: the effective config and file
// worker it inherits, its place in the run tree, the context it interpolates against, the `signal`
// that kills it in flight — an enclosing `parallel` block's (#24) or the operator's (#52) — and the
// `cancellation` that says which of the two it was.
/**
 * What one step needs: the run it belongs to, the sequence it sits in, and its own effective config.
 * Nothing else — every other field the three step runners used to take is reachable through `run`
 * or `exec`, which is why there is one of these instead of three overlapping literals (#76).
 */
interface StepContext {
  run: RunContext;
  exec: NodeExecContext;
  /** This step's config: the file's effective config with the step's own shadowing it (format §8). */
  stepConfig: ConfigObject;
}

// The tail every leaf step shares once its worker has produced a raw string output: apply
// `parse: "json"` (format doc §6.5) and emit the terminal `stepFinished`. A parse failure fails
// the step with its own run as the cause; otherwise the (parsed or raw) output succeeds. Keeps the
// parse/finish shape identical across binary and prompt steps so the two can't drift.
async function finishLeafStep(
  emit: Emit,
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
      await emit({ type: "step-finished", runId: ids.runId, rootRunId: ids.rootRunId, status: "failed", error: parseError });
      return { status: "failed", error: parseError, causeRunId: ids.runId };
    }
  }
  await emit({ type: "step-finished", runId: ids.runId, rootRunId: ids.rootRunId, status: "succeeded", output });
  return { status: "succeeded", output };
}

// The tail every leaf step shares once the engine has killed it instead of letting it finish (mvp
// spec §5.6): narrate the cancellation with its cause, then end the run `cancelled` rather than
// `failed` — so no publish from it lands. The cause is read off the enclosing `parallel` block's
// cancellation at kill time, and the two causes are exactly the two sources of an abort: a cause run
// there means a sibling branch failed and names it, while none means the abort came from outside the
// run tree — an operator cancelling the root run (#52), which has no cause run to point at.
async function cancelLeafStep(
  emit: Emit,
  ids: { runId: string; rootRunId: string },
  nodeId: string,
  cancellation: Cancellation | undefined,
): Promise<SeqOutcome> {
  const causeRunId = cancellation?.causeRunId ?? null;
  await emit({ type: "run-cancelled",
    runId: ids.runId,
    rootRunId: ids.rootRunId,
    nodeId,
    cause: causeRunId === null ? "operator" : "sibling-failed",
    causeRunId,
  });
  await emit({ type: "step-finished", runId: ids.runId, rootRunId: ids.rootRunId, status: "cancelled" });
  return { status: "cancelled" };
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
  ctx: StepContext,
): Promise<SeqOutcome> {
  const { emit } = ctx.run;
  const { rootRunId } = ctx.run.identity;
  const scope: InterpolationScope = { config: configScope(ctx.stepConfig), context: ctx.exec.context };
  const effectiveWorker: Worker = node.worker ?? ctx.run.file.worker;

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

  const release = await ctx.run.llm.semaphore.acquire();
  let result;
  try {
    const stepRunId = randomUUID();
    await emit({ type: "step-started",
      runId: stepRunId,
      rootRunId,
      parentRunId: ctx.run.identity.runId,
      nodeId: node.id,
      stepType: node.type,
      worker: effectiveWorker,
      input: stepInput,
    });

    result = await ctx.run.llm.worker.runPrompt({
      nodeId: node.id,
      model,
      prompt,
      input: stepInput,
      // The `options` bag is worker-side: MCP servers and skills pass straight through, and no
      // engine code interprets them (mvp spec §7).
      options: effectiveWorker.options,
      cwd: ctx.run.fileDir,
      signal: ctx.exec.signal,
    });

    if (result.status === "cancelled") {
      // A failing sibling parallel branch or an operator's cancel killed this processor (mvp spec
      // §5.6) — not a failure of this step. Awaited here rather than returned, so the processor slot
      // is only released once the cancellation has been narrated.
      return await cancelLeafStep(emit, { runId: stepRunId, rootRunId }, node.id, ctx.exec.cancellation);
    }

    // Leaf-only (§5.7): recorded on this run, never rolled up — subtree figures are a read-time SUM.
    if (result.usage !== null || result.estimatedCostUsd !== null) {
      await emit({ type: "step-usage",
        runId: stepRunId,
        rootRunId,
        usage: result.usage,
        estimatedCostUsd: result.estimatedCostUsd,
      });
    }

    if (result.status === "failed") {
      await emit({ type: "step-finished", runId: stepRunId, rootRunId, status: "failed", error: result.error });
      return { status: "failed", error: result.error, causeRunId: stepRunId };
    }

    return finishLeafStep(emit, { runId: stepRunId, rootRunId }, node, result.output);
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
  // `ctx.exec.signal` kills the child in flight — on a sibling branch's failure (#24) or an operator's
  // cancel of the root run (#52) — and `ctx.exec.cancellation` is what tells those two apart afterwards.
  ctx: StepContext,
): Promise<SeqOutcome> {
  const { emit } = ctx.run;
  const { rootRunId } = ctx.run.identity;
  const scope: InterpolationScope = { config: configScope(ctx.stepConfig), context: ctx.exec.context };
  const effectiveWorker: Worker = node.worker ?? ctx.run.file.worker;

  let command: string;
  let args: string[];
  let cwd: string;
  try {
    command = interpolateToString(node.command, scope);
    args = (node.args ?? []).map((arg) => interpolateToString(arg, scope));
    // A relative `cwd` is resolved against the workflow file's directory, not the process's —
    // the same anchor as the documented default (format doc §4.2). Anchoring it to wherever
    // `path run` happened to be invoked from would make `"cwd": "."` mean something different
    // from omitting `cwd`, and would make a workflow's behaviour depend on the caller's shell.
    cwd = node.cwd !== undefined ? resolve(ctx.run.fileDir, interpolateToString(node.cwd, scope)) : ctx.run.fileDir;
  } catch (err) {
    return { status: "failed", error: describeInterpolationError(node.id, err) };
  }

  const stepRunId = randomUUID();
  await emit({ type: "step-started",
    runId: stepRunId,
    rootRunId,
    parentRunId: ctx.run.identity.runId,
    nodeId: node.id,
    stepType: node.type,
    worker: effectiveWorker,
    input: stepInput,
  });

  const result = await runBinaryStep({ id: node.id, command, args, cwd }, stepInput, ctx.exec.signal);
  await emit({ type: "step-stderr", runId: stepRunId, rootRunId, stderr: result.stderr });

  if (result.status === "cancelled") {
    // A failing sibling parallel branch or an operator's cancel killed this child process (mvp spec
    // §5.6) — not a failure of this step.
    return cancelLeafStep(emit, { runId: stepRunId, rootRunId }, node.id, ctx.exec.cancellation);
  }

  if (result.status === "failed") {
    await emit({ type: "step-finished", runId: stepRunId, rootRunId, status: "failed", error: result.error });
    return { status: "failed", error: result.error, causeRunId: stepRunId };
  }

  return finishLeafStep(emit, { runId: stepRunId, rootRunId }, node, result.output);
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

  // Collect every `$secret` value in effective config once at run start (mvp spec §8.3, #20), then
  // scrub at the one point every observation passes through (#62) — the interpolated values handed
  // to workers stay real, only what crosses into persistence is masked. Masking here rather than in
  // a wrapper is what makes the guarantee unconditional: there is no hook to leave unimplemented and
  // no wrapper for a future caller to skip.
  const masker = collectSecrets(collectRunSecrets(file, options));
  for (const warning of masker.warnings) options.warn?.(warning);
  const { observer } = options;
  const emit: Emit = observer
    ? async (o) => {
        await observer.observe(masker.isEmpty ? o : maskObservation(masker, o));
      }
    : async () => {};

  return executeWorkflowRun({
    file,
    fileDir,
    input: options.input ?? {},
    incomingConfig: options.operatorConfig ?? {},
    identity: { runId, rootRunId: runId, parentRunId: null, nodeId: null },
    files: options.files,
    emit,
    // External abort (#52): the operator's signal is the root run's own, and threads down to every
    // descendant run and leaf step through `WorkflowRunParams.signal` exactly as a `parallel` block's
    // does. No `cancellation`: nothing inside the tree failed, so a run it kills has no cause run.
    signal: options.signal,
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

// A `checkpoint` node: assert its condition over the run's `context` (the branch's snapshot copy
// inside a `parallel`) + the predecessor's `output` (spec §5.2). True → continue; false or a
// strict evaluation error → the run stops as failed (§5.6). Transparent: forwards its
// predecessor's output unchanged — the same object its `output` root read (§5.4). The engine has
// no run for a checkpoint (invariant 1); the event is attributed to this run + the node's id.
async function runCheckpointNode(
  run: RunContext,
  node: CheckpointNode,
  incomingOutput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { emit, identity } = run;
  const { runId, rootRunId } = identity;
  const { outcome, trace } = evaluateCondition(node.condition, { context: exec.context, output: incomingOutput });
  const passed = outcome === "true";
  await emit({ type: "checkpoint-evaluated", runId, rootRunId, nodeId: node.id, passed, trace });
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
async function runBranchNode(
  run: RunContext,
  node: BranchNode,
  incomingOutput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { emit, identity } = run;
  const { runId, rootRunId } = identity;
  const roots = { context: exec.context, output: incomingOutput };
  const traces: Trace[] = [];
  for (const [index, arm] of node.arms.entries()) {
    const { outcome, trace } = evaluateCondition(arm.when, roots);
    traces.push(trace);
    if (outcome === "error") {
      return { status: "failed", error: `branch "${node.id}" arm ${index}: condition evaluation error: ${describeConditionFailure(trace)}` };
    }
    if (outcome === "true") {
      await emit({ type: "branch-taken", runId, rootRunId, nodeId: node.id, arm: index, trace });
      return runSequence(run, arm.body, incomingOutput, exec);
    }
  }
  if (node.else) {
    await emit({ type: "branch-taken", runId, rootRunId, nodeId: node.id, arm: "else", trace: null });
    return runSequence(run, node.else, incomingOutput, exec);
  }
  await emit({ type: "branch-no-match", runId, rootRunId, nodeId: node.id, traces });
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
async function runWhileDoNode(
  run: RunContext,
  node: WhileDoNode,
  incomingOutput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { emit, identity, fileConfig } = run;
  const { runId, rootRunId } = identity;
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
      await emit({ type: "loop-exited", runId, rootRunId, nodeId: node.id, reason: "condition-false", iterations, trace });
      return { status: "succeeded", output: iterationOutput };
    }
    // Condition true, but the cap has already been reached: the run fails (post-loop nodes may
    // assume the condition resolved false, so an exhausted loop is an authoring error, not an exit).
    if (iterations >= maxIterations) {
      await emit({ type: "loop-exited", runId, rootRunId, nodeId: node.id, reason: "max-iterations-exceeded", iterations, trace });
      return { status: "failed", error: `while-do "${node.id}": condition still true after max_iterations (${maxIterations}) — the run fails (spec §5.2)` };
    }
    iterations += 1;
    await emit({ type: "iteration-started", runId, rootRunId, nodeId: node.id, iteration: iterations, trace });
    const bodyOutcome = await runSequence(run, node.body, iterationOutput, exec);
    if (bodyOutcome.status !== "succeeded") return bodyOutcome;
    iterationOutput = bodyOutcome.output;
  }
}

/**
 * Runs **one node** of a workflow body, whatever kind it is: resolves its effective config and its
 * input, executes it, and lands its `publish`. `incomingOutput` is what the default-input chain
 * offers it — its predecessor's output (format doc §6.1).
 *
 * This is the engine's node seam, and there is one of it. Seven kinds sit behind it — three step
 * types executed on a worker, four engine-evaluated logicers and checkpoints (CONTEXT invariant 1)
 * — and a caller, or a test, needs to know none of that. Which of the seven a node is, what config
 * it inherits, whether its output publishes: all of that is on this side of the seam.
 *
 * It replaces five exported walkers and three private ones (#76 got as far as pulling the control
 * nodes to module scope, and stopped there). That split followed how far one ticket reached, not
 * the domain: `branch` was reachable by a test and `binary` was not, though a body may hold either
 * in the same position. Now every kind is reachable the same way, and none of them is a name a
 * caller has to learn.
 */
export async function runNode(
  run: RunContext,
  node: WorkflowNode,
  incomingOutput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  if (!isStepNode(node)) {
    if (node.type === "parallel") return runParallelNode(run, node, incomingOutput, exec);
    if (node.type === "checkpoint") return runCheckpointNode(run, node, incomingOutput, exec);
    if (node.type === "branch") return runBranchNode(run, node, incomingOutput, exec);
    if (node.type === "while-do") return runWhileDoNode(run, node, incomingOutput, exec);
    // Two guards, deliberately. The `never` assertion is the compile-time one: if the format gains
    // a node type this dispatch does not walk, the build fails rather than someone discovering it
    // by running a workflow. The runtime branch below survives anyway, because a hand-constructed
    // `WorkflowFile` can reach the engine without passing the schema — it must fail the run loudly
    // rather than be silently skipped.
    const unwalked: never = node;
    const unknown = unwalked as { type: string; id: string };
    return {
      status: "failed",
      error: `node type "${unknown.type}" (node "${unknown.id}") is not supported by this engine`,
    };
  }

  // Only steps carry config, an input map and a publish map — the control nodes are transparent to
  // all three, which is why this half of the function has no counterpart above.
  const stepConfig = mergeConfig(run.fileConfig, node.config);
  const scope: InterpolationScope = { config: configScope(stepConfig), context: exec.context };
  let stepInput: JsonValue;
  try {
    stepInput = node.input !== undefined ? interpolateValue(node.input, scope) : incomingOutput;
  } catch (err) {
    return { status: "failed", error: describeInterpolationError(node.id, err) };
  }

  // One context for all three step types, derived rather than hand-built. These were two literals
  // constructed side by side, sharing seven identical fields (#76).
  const step: StepContext = { run, exec, stepConfig };
  let outcome: SeqOutcome;
  if (node.type === "workflow") {
    outcome = await runWorkflowNode(node, stepInput, step);
  } else if (node.type === "prompt") {
    outcome = await runPromptNode(node, stepInput, step);
  } else {
    outcome = await runBinaryNode(node, stepInput, step);
  }
  if (outcome.status !== "succeeded" || !node.publish) return outcome;

  const publishScope: InterpolationScope = { config: configScope(stepConfig), context: exec.context, output: outcome.output };
  const updates: { [key: string]: JsonValue } = {};
  try {
    for (const [key, expr] of Object.entries(node.publish)) {
      updates[key] = interpolateValue(expr, publishScope);
    }
  } catch (err) {
    return { status: "failed", error: describeInterpolationError(node.id, err) };
  }
  // Every entry resolves before any is written, so the publish lands atomically (§5.3), before the
  // next node starts. A nested workflow-step publishes to *this* run's context only — never the
  // child's (isolated).
  Object.assign(exec.context, updates);
  await exec.onPublish(updates);
  return outcome;
}

/**
 * Walks a node sequence strictly in order (mvp spec §5.1), threading the default-input chain: a
 * node with no `input` reads its predecessor's output (`seedInput` for the first node — the
 * block's predecessor's output, format doc §6.1). Returns the last node's output, or the first
 * non-success outcome (fail-fast).
 *
 * What one node does is `runNode`'s; what a sequence does is this: order, the chain, and where an
 * abort can be noticed. This one function serves the top-level body, each `parallel` branch, each
 * branch arm and each loop iteration — every block is transparent to one uniform chain (§5.4).
 */
export async function runSequence(
  run: RunContext,
  nodes: WorkflowFile["body"],
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  let previous: JsonValue = seedInput;

  for (const node of nodes) {
    // An abort that arrived between two nodes stops the walk here (mvp spec §5.6): starting a step
    // run only to kill it would put a run in the record that never really ran, and the control
    // nodes around it — a checkpoint, a while-do's next iteration — have no process to interrupt,
    // so this is the only place they can notice a cancellation at all.
    if (exec.signal?.aborted) return { status: "cancelled" };

    const outcome = await runNode(run, node, previous, exec);
    if (outcome.status !== "succeeded") return outcome;
    previous = outcome.output;
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
  run: RunContext,
  node: Extract<WorkflowFile["body"][number], { type: "parallel" }>,
  seedInput: JsonValue,
  exec: NodeExecContext,
): Promise<SeqOutcome> {
  const { emit, identity } = run;
  const { runId, rootRunId } = identity;
  const controller = new AbortController();
  // A nested parallel inherits its enclosing block's cancellation: if the outer block aborts, this
  // one aborts too, so this block's own in-flight steps are killed as well.
  const outerSignal = exec.signal;
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }

  let causeRunId: string | null = null;
  const cancellation: Cancellation = {
    signal: controller.signal,
    get causeRunId() {
      // Read through to the enclosing block at read time, not at block entry: an *outer* sibling
      // may fail after this block started, and its failing run is still this block's cause.
      return causeRunId ?? exec.cancellation?.causeRunId ?? null;
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
      const outcome = await runSequence(run, branch.body, seedInput, {
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
  await emit({ type: "join-applied",
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
