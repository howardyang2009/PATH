import { readFileSync } from "node:fs";
import {
  type ConfigObject,
  type JsonValue,
  launchInput,
  validateLaunchWorkerDefaults,
} from "@path/schema";
import { loadWorkflowTree } from "../load-workflow-tree.js";
import { mergeConfig } from "../merge-config.js";
import {
  type ListEligibleResult,
  openProject,
  type ProjectRunOptions,
  type ResumeResult,
} from "../project.js";
import {
  type RunReport,
  renderListEligible,
  renderResume,
  renderRunOutcome,
  SIGINT_EXIT_CODE,
} from "../run-report.js";
import type { RunResult } from "../run-workflow.js";
import type { CliIo, RunOverrides } from "./io.js";
import { parseRunInvocation } from "./parse-run.js";

type ConfigResult = { success: true; config: ConfigObject } | { success: false; error: string };

// Shared by `--config`/`--set` and `--context`/`--set-context`: a whole-object file loads first, then
// repeatable `key=value` pairs override top-level keys, each JSON.parse-or-raw-string, nearest-wins.
function buildKeyedConfig(
  fileFlag: string,
  file: string | undefined,
  _pairFlag: string,
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

export async function runRunCommand(
  rest: string[],
  io: CliIo,
  overrides: RunOverrides,
): Promise<number> {
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
