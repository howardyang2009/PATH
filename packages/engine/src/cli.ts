import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  type ConfigObject,
  type JsonValue,
  launchInput,
  RUN_STATUSES,
  type RunStatus,
  validateLaunchWorkerDefaults,
} from "@path/schema";
import { loadWorkflowTree } from "./load-workflow-tree.js";
import { isLogBackendId, LOG_BACKEND_IDS, type LogBackendId } from "./logging/backends.js";
import { mergeConfig } from "./merge-config.js";
import {
  type ListEligibleResult,
  openProject,
  type ProjectRunOptions,
  type ResumeResult,
} from "./project.js";
import { type ListRootsOptions, openRunArchive, type RunArchive } from "./run-archive.js";
import {
  formatRunsTable,
  type RunReport,
  type RunsTableRow,
  renderListEligible,
  renderResume,
  renderRunOutcome,
  SIGINT_EXIT_CODE,
} from "./run-report.js";
import type { RunResult, WorkerOverrides } from "./run-workflow.js";

export interface CliIo {
  log(message: string): void;
  error(message: string): void;
  /** Ask a yes/no question; `undefined` means the surface cannot ask, which counts as "not confirmed". */
  confirm?(question: string): Promise<boolean> | undefined;
}

/** Collaborators the CLI would otherwise construct; the acceptance run injects a scripted LLM worker. */
export interface RunOverrides {
  /** Replace named `(type, worker)` pairs in the scanned registry, forwarded to `runWorkflow` verbatim. */
  workerOverrides?: WorkerOverrides;
  /** How a forced second `^C` leaves the process — defaults to `process.exit(130)`; tests substitute their own. */
  forceExit?: (code: number) => void;
}

const consoleIo: CliIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  // Only an interactive stdin can answer; `y`/`yes` (any case) is the only accepted yes.
  confirm: (question) => {
    if (!process.stdin.isTTY) return undefined;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return rl
      .question(`${question} `)
      .then((answer) => /^y(es)?$/i.test(answer.trim()))
      .finally(() => rl.close());
  },
};

// How many root-run ids `prune` prints before collapsing the rest to "... and N more".
const PRUNE_ID_PREVIEW = 20;

const RUN_USAGE =
  "usage: path run <workflow.json> [-C <dir>] [--resume <root-run-id> [--from <run-id> | --list-eligible]] [--config <config.json>] [--set key=value]... [--worker-default type=name]... [--context <context.json>] [--set-context key=value]... [--log-backends db,ndjson] [--processor-concurrency <n>]";
const RUNS_USAGE =
  "usage: path runs [-C <dir>] [--limit <n>] [--status <status>] [--workflow <name>] [--workflow-id <guid>] | path runs [-C <dir>] rm [--force] <root-run-id> | path runs [-C <dir>] prune [--yes]";

/**
 * What `path run` was asked to do, as a value: three arms, each carrying only the flags its form can
 * use, so illegal flag combinations are unconstructable and the run assembly reads one shape.
 */
export interface LaunchInvocation {
  kind: "launch";
  workflowPath: string;
  /** `-C <dir>`: the directory whose `.path/` store this run reads and writes. */
  storeDir?: string;
  configFile?: string;
  setPairs: readonly (readonly [string, string])[];
  workerDefaultPairs: readonly (readonly [string, string])[];
  contextFile?: string;
  setContextPairs: readonly (readonly [string, string])[];
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
}

/**
 * The resume form: its starting context is rebuilt from the original tree and a launch worker-default
 * is fixed at launch, so both are refused and carried as `undefined`/empty here instead.
 */
export interface ResumeInvocation {
  kind: "resume";
  workflowPath: string;
  storeDir?: string;
  resumeRootRunId: string;
  /** `--from <run-id>`: the rerun boundary K; the CLI does zero K-logic and forwards it to `Project`. */
  rerunFromRunId?: string;
  configFile?: string;
  setPairs: readonly (readonly [string, string])[];
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
  workerDefaultPairs?: undefined;
  contextFile?: undefined;
  setContextPairs?: undefined;
}

/** `--list-eligible`: a dry-run of Resume that lists candidate Ks and launches nothing. */
export interface ListEligibleInvocation {
  kind: "list-eligible";
  workflowPath: string;
  storeDir?: string;
  resumeRootRunId: string;
  configFile?: undefined;
  /** Never present: `--set` is a launch flag, refused with `--list-eligible`. */
  setPairs?: undefined;
  workerDefaultPairs?: undefined;
  contextFile?: undefined;
  /** Never present, as `setPairs`: the listing builds no context seed. */
  setContextPairs?: undefined;
  logBackends?: undefined;
  processorConcurrency?: undefined;
}

export type RunInvocation = LaunchInvocation | ResumeInvocation | ListEligibleInvocation;

export type RunInvocationResult =
  | { success: true; invocation: RunInvocation }
  | { success: false; error: string };

// Operator launch-time config via CLI flags and/or a config file (spec §3): `--config` loads a whole
// object, repeatable `--set key=value` overrides top-level keys, both merging over file defaults.
export function parseRunInvocation(argv: string[]): RunInvocationResult {
  // `-C <dir>` can appear anywhere, so it is stripped before the positional is taken. Absent means the
  // store defaults to the workflow file's own directory.
  const dirFlag = extractDirFlag(argv, RUN_USAGE);
  if (!dirFlag.success) return dirFlag;
  const storeDir = dirFlag.dir;

  const [workflowPath, ...rest] = dirFlag.rest;
  if (!workflowPath) return { success: false, error: RUN_USAGE };

  let resumeRootRunId: string | undefined;
  let rerunFromRunId: string | undefined;
  let listEligible = false;
  let configFile: string | undefined;
  const setPairs: [string, string][] = [];
  const workerDefaultPairs: [string, string][] = [];
  let contextFile: string | undefined;
  const setContextPairs: [string, string][] = [];
  let logBackends: LogBackendId[] | undefined;
  let processorConcurrency: number | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--resume") {
      const taken = takeValue(rest, i, "--resume", "a root run id", RUN_USAGE);
      if (!taken.success) return taken;
      resumeRootRunId = taken.value;
      i += 1;
    } else if (flag === "--from") {
      const taken = takeValue(rest, i, "--from", "a run id", RUN_USAGE);
      if (!taken.success) return taken;
      rerunFromRunId = taken.value;
      i += 1;
    } else if (flag === "--list-eligible") {
      listEligible = true;
    } else if (flag === "--config") {
      const taken = takeValue(rest, i, "--config", "a path", RUN_USAGE);
      if (!taken.success) return taken;
      configFile = taken.value;
      i += 1;
    } else if (flag === "--set") {
      const taken = takePair(rest, i, "--set", "key=value", RUN_USAGE);
      if (!taken.success) return taken;
      setPairs.push(taken.pair);
      i += 1;
    } else if (flag === "--worker-default") {
      // Both sides non-empty: an empty worker name is an operator mistake at parse (exit 2), not a
      // mid-run failure; registry-relative validity is the launch-boundary check, not this shape check.
      const taken = takePair(rest, i, "--worker-default", "type=name", RUN_USAGE, {
        valueRequired: true,
      });
      if (!taken.success) return taken;
      workerDefaultPairs.push(taken.pair);
      i += 1;
    } else if (flag === "--context") {
      const taken = takeValue(rest, i, "--context", "a path", RUN_USAGE);
      if (!taken.success) return taken;
      contextFile = taken.value;
      i += 1;
    } else if (flag === "--set-context") {
      const taken = takePair(rest, i, "--set-context", "key=value", RUN_USAGE);
      if (!taken.success) return taken;
      setContextPairs.push(taken.pair);
      i += 1;
    } else if (flag === "--log-backends") {
      const value = rest[i + 1];
      const parsed = parseLogBackends(value);
      if (!parsed.success) return parsed;
      logBackends = parsed.ids;
      i += 1;
    } else if (flag === "--processor-concurrency") {
      const value = rest[i + 1];
      const parsed = parseProcessorConcurrency(value);
      if (!parsed.success) return parsed;
      processorConcurrency = parsed.value;
      i += 1;
    } else {
      return { success: false, error: `unrecognized argument "${flag}"\n${RUN_USAGE}` };
    }
  }

  // A resumed run's context is rebuilt from the original tree, so a supplied seed is refused outright
  // rather than silently discarded.
  if (resumeRootRunId !== undefined && (contextFile !== undefined || setContextPairs.length > 0)) {
    return {
      success: false,
      error: `--context/--set-context cannot be combined with --resume: a resumed run's context is rebuilt from the original tree\n${RUN_USAGE}`,
    };
  }

  // A launch worker-default is fixed at launch and identity-defining, so supplying one with `--resume`
  // is refused rather than silently discarded — changing the worker is a new run, not a resume.
  if (resumeRootRunId !== undefined && workerDefaultPairs.length > 0) {
    return {
      success: false,
      error: `--worker-default cannot be combined with --resume: a launch worker-default is fixed at launch (ADR 0044); changing it is a new run, not a resume\n${RUN_USAGE}`,
    };
  }

  // `--from` names the rerun boundary K within a resume, so it is meaningless without `--resume`.
  if (rerunFromRunId !== undefined && resumeRootRunId === undefined) {
    return { success: false, error: `--from requires --resume\n${RUN_USAGE}` };
  }

  // `--list-eligible` is a dry-run of resume: it requires `--resume`, excludes `--from`, and refuses
  // the launch-only flags because it launches nothing.
  if (listEligible) {
    if (resumeRootRunId === undefined) {
      return { success: false, error: `--list-eligible requires --resume\n${RUN_USAGE}` };
    }
    if (rerunFromRunId !== undefined) {
      return {
        success: false,
        error: `--list-eligible cannot be combined with --from: one lists candidate rerun boundaries, the other resumes from a chosen one\n${RUN_USAGE}`,
      };
    }
    // `--context`/`--set-context` and `--worker-default` are already refused above whenever `--resume`
    // is set, so they cannot reach this block; the rest only configure a launch this mode does not do.
    const launchFlag =
      configFile !== undefined
        ? "--config"
        : setPairs.length > 0
          ? "--set"
          : logBackends !== undefined
            ? "--log-backends"
            : processorConcurrency !== undefined
              ? "--processor-concurrency"
              : undefined;
    if (launchFlag !== undefined) {
      return {
        success: false,
        error: `--list-eligible cannot be combined with ${launchFlag}: it launches nothing\n${RUN_USAGE}`,
      };
    }
  }

  // The guards above decide the form: the listing first, then the resume form, then a launch.
  if (listEligible && resumeRootRunId !== undefined) {
    return {
      success: true,
      invocation: { kind: "list-eligible", workflowPath, storeDir, resumeRootRunId },
    };
  }
  if (resumeRootRunId !== undefined) {
    return {
      success: true,
      invocation: {
        kind: "resume",
        workflowPath,
        storeDir,
        resumeRootRunId,
        rerunFromRunId,
        configFile,
        setPairs,
        logBackends,
        processorConcurrency,
      },
    };
  }
  return {
    success: true,
    invocation: {
      kind: "launch",
      workflowPath,
      storeDir,
      configFile,
      setPairs,
      workerDefaultPairs,
      contextFile,
      setContextPairs,
      logBackends,
      processorConcurrency,
    },
  };
}

type TakeValueResult = { success: true; value: string } | { success: false; error: string };

// The argument after a value-flag at `args[i]`, or a usage error naming the flag. The caller advances
// `i`; `noun` is the flag's own wording ("a path", "a guid").
function takeValue(
  args: string[],
  i: number,
  flag: string,
  noun: string,
  usage: string,
): TakeValueResult {
  const value = args[i + 1];
  if (!value) return { success: false, error: `${flag} requires ${noun} argument\n${usage}` };
  return { success: true, value };
}

type TakePairResult = { success: true; pair: [string, string] } | { success: false; error: string };

// The `<key>=<value>` argument after a pair-flag, split at the first `=`; the key must be non-empty and
// `valueRequired` also refuses an empty value (unlike an empty config string).
function takePair(
  args: string[],
  i: number,
  flag: string,
  shape: string,
  usage: string,
  { valueRequired = false }: { valueRequired?: boolean } = {},
): TakePairResult {
  const pair = args[i + 1];
  const eq = pair?.indexOf("=") ?? -1;
  if (!pair || eq <= 0 || (valueRequired && eq === pair.length - 1)) {
    return { success: false, error: `${flag} requires a ${shape} argument\n${usage}` };
  }
  return { success: true, pair: [pair.slice(0, eq), pair.slice(eq + 1)] };
}

type PositiveIntResult = { success: true; value: number } | { success: false; error: string };

// The one positive-integer flag check, shared by `--processor-concurrency` and `runs`' `--limit`;
// `flag`/`usage` name the offending flag and its command's usage.
function parsePositiveInt(
  flag: string,
  value: string | undefined,
  usage: string,
): PositiveIntResult {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed <= 0) {
    return { success: false, error: `${flag} requires a positive integer\n${usage}` };
  }
  return { success: true, value: parsed };
}

// The engine-wide Processor cap (spec §5.5): ~400 MB per live processor, so this is the memory knob.
function parseProcessorConcurrency(value: string | undefined): PositiveIntResult {
  return parsePositiveInt("--processor-concurrency", value, RUN_USAGE);
}

type LogBackendsResult = { success: true; ids: LogBackendId[] } | { success: false; error: string };

// The engine-level `log.backends` setting: a comma-separated list; absent means both are on by default.
function parseLogBackends(value: string | undefined): LogBackendsResult {
  if (!value) return { success: false, error: `--log-backends requires a value\n${RUN_USAGE}` };
  if (value === "none") return { success: true, ids: [] };

  const ids: LogBackendId[] = [];
  for (const raw of value.split(",")) {
    const id = raw.trim();
    if (!isLogBackendId(id)) {
      return {
        success: false,
        error: `--log-backends: unknown backend "${id}" (choose from ${LOG_BACKEND_IDS.join(", ")}, or "none")`,
      };
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { success: true, ids };
}

type ConfigResult = { success: true; config: ConfigObject } | { success: false; error: string };

// Shared by `--config`/`--set` and `--context`/`--set-context`: a whole-object file loads first, then
// repeatable `key=value` pairs override top-level keys, each JSON.parse-or-raw-string, nearest-wins.
function buildKeyedConfig(
  fileFlag: string,
  file: string | undefined,
  pairFlag: string,
  pairs: readonly (readonly [string, string])[],
): ConfigResult {
  let config: ConfigObject = {};

  if (file) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      return {
        success: false,
        error: `cannot read ${fileFlag} file "${file}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { success: false, error: `${fileFlag} file "${file}" must contain a JSON object` };
    }
    config = mergeConfig(config, raw as ConfigObject);
  }

  for (const [key, value] of pairs) {
    let parsedValue: ConfigObject[string];
    try {
      parsedValue = JSON.parse(value);
    } catch {
      parsedValue = value; // bare strings need no quoting on the command line
    }
    config = mergeConfig(config, { [key]: parsedValue });
  }

  return { success: true, config };
}

function buildOperatorConfig(args: {
  configFile?: string | undefined;
  setPairs?: readonly (readonly [string, string])[] | undefined;
}): ConfigResult {
  return buildKeyedConfig("--config", args.configFile, "--set", args.setPairs ?? []);
}

// Fold the repeatable `--worker-default` pairs into the `{ <type>: <name> }` table: a shallow
// per-type nearest-wins merge, no JSON parse and no file. No pairs yields `undefined`.
function buildLaunchWorkerDefaults(args: {
  workerDefaultPairs?: readonly (readonly [string, string])[];
}): { [stepType: string]: string } | undefined {
  const pairs = args.workerDefaultPairs ?? [];
  if (pairs.length === 0) return undefined;
  const table: { [stepType: string]: string } = {};
  for (const [type, name] of pairs) table[type] = name;
  return table;
}

type ContextResult =
  | { success: true; context: { [key: string]: JsonValue } }
  | { success: false; error: string };

// The starting-context seed for a fresh (non-`--resume`) run, feeding `RunOptions.input`.
function buildContextSeed(args: {
  contextFile?: string | undefined;
  setContextPairs?: readonly (readonly [string, string])[] | undefined;
}): ContextResult {
  const result = buildKeyedConfig(
    "--context",
    args.contextFile,
    "--set-context",
    args.setContextPairs ?? [],
  );
  if (!result.success) return result;

  // A context seed is plain JSON, never `$secret`/`$env` wrappers, which are a `config`-only concept;
  // so this narrowing is exact, not a runtime assumption.
  return { success: true, context: result.config as { [key: string]: JsonValue } };
}

interface SigintCancellation {
  /** Handed to `RunOptions.signal`: the operator's way into the engine's own unwind. */
  signal: AbortSignal;
  /** Removes the listener — the CLI owns the process signal only while a run is in flight. */
  dispose(): void;
}

/**
 * Makes `^C` truthful: the first press cancels the run so it unwinds the engine's normal way (leaf
 * killed, `run-cancelled` with `cause: "operator"`, row `cancelled`); cancellation holds no deadline, so
 * a second press exits immediately — the only path where the CLI exits by itself.
 */
function cancelOnSigint(io: CliIo, forceExit: (code: number) => void): SigintCancellation {
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) {
      forceExit(SIGINT_EXIT_CODE);
      return;
    }
    // Forcing abandons the unwind, so the rows keep whatever status they held; `path runs rm` is the remedy.
    io.error(
      "cancelling… (Ctrl-C again to force — leaves the run's rows `running`; clear with `path runs rm`)",
    );
    controller.abort();
  };

  process.on("SIGINT", onSigint);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", onSigint);
    },
  };
}

async function runRunCommand(rest: string[], io: CliIo, overrides: RunOverrides): Promise<number> {
  const parsed = parseRunInvocation(rest);
  if (!parsed.success) {
    io.error(parsed.error);
    return 2;
  }
  const invocation = parsed.invocation;

  const operatorConfig = buildOperatorConfig(invocation);
  if (!operatorConfig.success) {
    io.error(operatorConfig.error);
    return 2;
  }

  const contextSeed = buildContextSeed(invocation);
  if (!contextSeed.success) {
    io.error(contextSeed.error);
    return 2;
  }

  const loadResult = await loadWorkflowTree(invocation.workflowPath);
  if (!loadResult.success) {
    io.error(loadResult.errors.join("\n"));
    return 1;
  }

  // Whole-tree validation happened above; execution follows `workflow` step refs via `runWorkflow`'s `files`.
  const { workflow } = loadResult;

  // The launch worker-default table is operator input authored in no file, so a bad entry is a bad
  // request, not an engine fault: refuse it here, exit 2, against the registry the load validated the
  // file with. Every bad entry is reported in one pass, each prefixed `--worker-default:`.
  const launchWorkerDefaults = buildLaunchWorkerDefaults(invocation);
  const workerDefaultErrors = validateLaunchWorkerDefaults(launchWorkerDefaults, workflow.registry);
  if (workerDefaultErrors.length > 0) {
    io.error(workerDefaultErrors.map((message) => `--worker-default: ${message}`).join("\n"));
    return 2;
  }

  // `-C <dir>` overrides only where the `.path/` store lives: the store opens at `projectDir`, while
  // `workflow.workflowDir` — what nested `workflow` refs and binary `cwd`s resolve against — stays the
  // workflow file's own directory.
  const projectDir = invocation.storeDir ?? workflow.workflowDir;
  const opened = openProject(projectDir);
  if (!opened.success) {
    io.error(opened.error);
    // A malformed engine-settings file is an operator mistake, like a bad flag; an unopenable db is not.
    return opened.kind === "settings" ? 2 : 1;
  }
  const project = opened.project;

  // `--list-eligible` reads the source tree and prints per-node eligibility, launching nothing; the
  // `files` tree lets the shared legal-K predicate descend a nested K's refs, exactly as `resume` passes it.
  if (invocation.kind === "list-eligible") {
    let listResult: ListEligibleResult;
    try {
      listResult = project.listEligible(
        workflow.rootFile,
        invocation.resumeRootRunId,
        workflow.workflowDir,
        workflow.files,
      );
    } finally {
      project.close();
    }
    return emit(renderListEligible(listResult), io);
  }

  // Installed only for the run itself, and removed the moment it settles.
  const sigint = cancelOnSigint(io, overrides.forceExit ?? ((code) => process.exit(code)));

  // Backends, observer order and settings precedence belong to the project; here the CLI owns only the
  // parsed flags, the signal, and where warnings go. `input` is the fresh-run context seed only.
  const projectOptions: ProjectRunOptions = {
    operatorConfig: operatorConfig.config,
    // The validated launch worker-default table; `undefined` when none was passed, so a flagless run
    // resolves through the file tier unchanged.
    launchWorkerDefaults,
    files: workflow.files,
    // The registry this file was validated against: dispatch reuses it and never re-scans the folder.
    registry: workflow.registry,
    logBackends: invocation.logBackends,
    processorConcurrency: invocation.processorConcurrency,
    workerOverrides: overrides.workerOverrides,
    warn: (message) => io.error(`warning: ${message}`),
    signal: sigint.signal,
    // Source-workflow provenance for the root row: the workflow file's path relative to the store dir,
    // so a central `-C` store distinguishes two same-named workflows. Recorded on fresh runs and resumes.
    sourceWorkflowPath: workflow.storeRelativePath(projectDir),
  };

  if (invocation.kind === "resume") {
    let resumeResult: ResumeResult;
    try {
      resumeResult = await project.resume(
        workflow.rootFile,
        invocation.resumeRootRunId,
        workflow.workflowDir,
        // `--from` forwarded verbatim: the CLI does zero K-logic, `Project.resume` is the one authority.
        { ...projectOptions, rerunFromRunId: invocation.rerunFromRunId },
      );
    } finally {
      sigint.dispose();
      project.close();
    }
    return emit(renderResume(resumeResult), io);
  }

  // Only the launch form reaches here, and only a launch carries a context seed.
  let runResult: RunResult;
  try {
    runResult = await project.run(workflow.rootFile, workflow.workflowDir, {
      ...projectOptions,
      // A non-empty context seed wins over the file's top-level `input`, the one rule every launch door
      // shares, so a file declaring `input` runs the same way wherever it is launched.
      ...launchInput(contextSeed.context, workflow.rootFile.input),
    });
  } finally {
    sigint.dispose();
    project.close();
  }

  // A fresh run prints its output on success; a cancelled/failed one has no output contract.
  if (runResult.status === "succeeded") {
    io.log(
      typeof runResult.output === "string" ? runResult.output : JSON.stringify(runResult.output),
    );
    return 0;
  }
  return emit(renderRunOutcome(runResult.status, runResult.error), io);
}

// The one shell turning a pure {@link RunReport} into effects: stdout lines, then stderr lines, then
// the exit code. `run-report.ts` owns what an outcome says; this owns that it is written.
function emit(report: RunReport, io: CliIo): number {
  for (const line of report.stdout) io.log(line);
  for (const line of report.stderr) io.error(line);
  return report.exitCode;
}

// `-C <dir>` can appear anywhere in a `runs` invocation, ahead of or behind the subcommand, so it is
// stripped before the rest of parsing sees it rather than pinned to one position.
type ExtractDirFlagResult =
  | { success: true; dir: string | undefined; rest: string[] }
  | { success: false; error: string };

function extractDirFlag(args: string[], usage: string): ExtractDirFlagResult {
  const rest: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-C") {
      const value = args[i + 1];
      if (!value) return { success: false, error: `-C requires a directory argument\n${usage}` };
      dir = value;
      i += 1;
    } else {
      rest.push(args[i]!);
    }
  }
  return { success: true, dir, rest };
}

type ListRootsArgsResult =
  | { success: true; options: ListRootsOptions }
  | { success: false; error: string };

// The bare `path runs` listing reuses `listRoots`' `--limit`/`--status` filters, `--status` validated
// against the domain's own set so an unknown status is refused rather than silently matching nothing.
function parseRunsListArgs(args: string[]): ListRootsArgsResult {
  let limit: number | undefined;
  let status: RunStatus | undefined;
  let workflowName: string | undefined;
  let workflowId: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--limit") {
      const parsed = parsePositiveInt("--limit", args[i + 1], RUNS_USAGE);
      if (!parsed.success) return parsed;
      limit = parsed.value;
      i += 1;
    } else if (flag === "--status") {
      const value = args[i + 1];
      if (!value || !RUN_STATUSES.includes(value as RunStatus)) {
        return {
          success: false,
          error: `--status requires one of ${RUN_STATUSES.join(", ")}\n${RUNS_USAGE}`,
        };
      }
      status = value as RunStatus;
      i += 1;
    } else if (flag === "--workflow") {
      // Exact match on the source workflow's human `name` — the display key in this table.
      const taken = takeValue(args, i, "--workflow", "a name", RUNS_USAGE);
      if (!taken.success) return taken;
      workflowName = taken.value;
      i += 1;
    } else if (flag === "--workflow-id") {
      // Exact match on the durable GUID — unambiguous where two files share a `name`.
      const taken = takeValue(args, i, "--workflow-id", "a guid", RUNS_USAGE);
      if (!taken.success) return taken;
      workflowId = taken.value;
      i += 1;
    } else {
      return { success: false, error: `unrecognized argument "${flag}"\n${RUNS_USAGE}` };
    }
  }

  return { success: true, options: { limit, status, workflowName, workflowId } };
}

// `path runs` with no subcommand: the first listing surface, over the same query `rm`/`prune` operate
// on. The `resumed-from` cell asks which predecessor ids still have rows, not which are on this page.
async function runRunsListCommand(args: string[], dir: string, io: CliIo): Promise<number> {
  const parsed = parseRunsListArgs(args);
  if (!parsed.success) {
    io.error(parsed.error);
    return 2;
  }

  return withRunArchive(dir, io, (archive) => {
    const roots = archive.listRoots(parsed.options);
    const predecessorIds = roots
      .map((run) => run.resumedFromRootRunId)
      .filter((id): id is string => id !== null);
    const live = archive.existingRunIds(predecessorIds);

    const rows = roots.map((run): RunsTableRow => {
      const predecessor = run.resumedFromRootRunId;
      const resumedFrom =
        predecessor === null
          ? "-"
          : live.has(predecessor)
            ? predecessor
            : `${predecessor} (deleted)`;
      // The human `name` is the display key; "-" is the defensive floor for a row with no recorded identity.
      return [
        run.runId,
        run.workflowName ?? "-",
        run.status,
        run.startedAt ?? "-",
        run.finishedAt ?? "-",
        resumedFrom,
      ];
    });

    io.log(formatRunsTable(rows));
    return 0;
  });
}

/** Open the run archive under `dir`, hand it to `use`, and close it however `use` ends; a failed open exits 1. */
async function withRunArchive(
  dir: string,
  io: CliIo,
  use: (archive: RunArchive) => number | Promise<number>,
): Promise<number> {
  const opened = openRunArchive(dir);
  if (!opened.success) {
    io.error(opened.error);
    return 1;
  }
  try {
    return await use(opened.archive);
  } finally {
    opened.close();
  }
}

// `runs rm`/`runs prune` take no workflow-file argument: they operate on the `.path/` in the cwd, or on
// `-C <dir>` when given one.
async function runRunsCommand(args: string[], io: CliIo): Promise<number> {
  const dirFlag = extractDirFlag(args, RUNS_USAGE);
  if (!dirFlag.success) {
    io.error(dirFlag.error);
    return 2;
  }
  const dir = dirFlag.dir ?? process.cwd();
  const [subcommand, ...rest] = dirFlag.rest;

  if (subcommand === "rm") {
    // `--force` overrides the live-reuse-marker block; splitting flags from operands keeps the "exactly
    // one id" check counting ids, not the flag.
    const force = rest.includes("--force");
    const unknownFlag = rest.find((arg) => arg.startsWith("--") && arg !== "--force");
    if (unknownFlag !== undefined) {
      io.error(`unknown flag "${unknownFlag}"\n${RUNS_USAGE}`);
      return 2;
    }
    const operands = rest.filter((arg) => !arg.startsWith("--"));
    const rootRunId = operands[0];
    if (!rootRunId) {
      io.error(RUNS_USAGE);
      return 2;
    }
    // One id, not a list: a second operand is refused rather than silently dropped.
    if (operands.length > 1) {
      io.error(`runs rm takes exactly one run id, got ${operands.length}\n${RUNS_USAGE}`);
      return 2;
    }

    return withRunArchive(dir, io, (archive) => {
      // The guard reads before deleting: a live successor reusing this tree's data blocks the delete
      // unless `--force`; a not-found id has no blockers and falls through to `remove`'s own error.
      const blockers = archive.blockingSuccessors(rootRunId);
      if (blockers.length > 0 && !force) {
        io.error(
          `refusing to remove ${rootRunId}: live successor run(s) reuse its data: ${blockers.join(", ")}\n` +
            `re-run with --force to delete it anyway — those successors would keep a dangling reference`,
        );
        return 1;
      }
      // "Found" means either store held something: an orphaned directory with no rows still counts, so
      // `rm` finishes a half-done cleanup rather than reporting "not found" while deleting it anyway.
      if (!archive.remove(rootRunId)) {
        io.error(`no run found with id "${rootRunId}"`);
        return 1;
      }
      io.log(`removed run ${rootRunId}`);
      // `--force` deletes exactly the named tree, no cascade, so the successors it orphaned are named
      // here or the dangling reference stays invisible.
      if (blockers.length > 0) {
        io.log(`orphaned successor run(s): ${blockers.join(", ")}`);
      }
      return 0;
    });
  }

  if (subcommand === "prune") {
    // `prune` takes no operands: a destructive verb must be at least as strict about its input as `run`
    // is. `--yes`/`-y` skip the confirmation prompt for scripted use.
    const yes = rest.includes("--yes") || rest.includes("-y");
    const badArg = rest.find((arg) => arg !== "--yes" && arg !== "-y");
    if (badArg !== undefined) {
      io.error(`runs prune takes no arguments, got "${badArg}"\n${RUNS_USAGE}`);
      return 2;
    }

    return withRunArchive(dir, io, async (archive) => {
      // Confirm before deleting: a bare `prune` wipes every root. `--yes` skips the gate; an empty
      // project prunes unprompted. `listRoots` defaults to a 50-row page, so pass an unbounded limit.
      const roots = archive.listRoots({ limit: Number.MAX_SAFE_INTEGER });
      if (!yes && roots.length > 0) {
        // Cap the printed ids so thousands of roots do not bury the prompt; the count is the true total.
        const shown = roots.slice(0, PRUNE_ID_PREVIEW);
        const more = roots.length - shown.length;
        io.log(
          `prune will permanently delete all ${roots.length} root run(s) and cannot be undone:\n` +
            shown.map((root) => `  ${root.runId}`).join("\n") +
            (more > 0 ? `\n  ... and ${more} more` : "") +
            `\npass --yes to skip this prompt.`,
        );
        const confirmed = await io.confirm?.("delete them? [y/N]");
        if (!confirmed) {
          io.error("aborted: nothing was removed");
          return 1;
        }
      }
      const deleted = archive.prune();
      io.log(`pruned ${deleted} run(s)`);
      return 0;
    });
  }

  // No subcommand, or a leading flag, is the bare listing; any other word earns the usage error.
  if (subcommand === undefined || subcommand.startsWith("--")) {
    return runRunsListCommand(dirFlag.rest, dir, io);
  }

  io.error(RUNS_USAGE);
  return 2;
}

/** Runs the CLI and returns the process exit code — never calls process.exit itself. */
export async function main(
  argv: string[],
  io: CliIo = consoleIo,
  overrides: RunOverrides = {},
): Promise<number> {
  const [command, ...rest] = argv;

  // Help is answered before dispatch, so it can never reach a subcommand and be mistaken for an operand.
  if (command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
    io.log(`${RUN_USAGE}\n${RUNS_USAGE}`);
    return 0;
  }

  if (command === "run") {
    return runRunCommand(rest, io, overrides);
  }
  if (command === "runs") {
    return runRunsCommand(rest, io);
  }

  io.error(`${RUN_USAGE}\n${RUNS_USAGE}`);
  return 2;
}
