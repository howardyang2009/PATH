import { isLogBackendId, LOG_BACKEND_IDS, type LogBackendId } from "../logging/backends.js";
import {
  extractDirFlag,
  type PositiveIntResult,
  parsePositiveInt,
  takePair,
  takeValue,
} from "./args.js";

export const RUN_USAGE =
  "usage: path run <workflow.json> [-C <dir>] [--resume <root-run-id> [--from <run-id> | --list-eligible]] [--config <config.json>] [--set key=value]... [--worker-default type=name]... [--context <context.json>] [--set-context key=value]... [--log-backends db,ndjson] [--processor-concurrency <n>]";

/**
 * What `path run` was asked to do, as a value: three arms, each carrying only the flags its form
 * can use, so illegal flag combinations are unconstructable and the run assembly reads one shape.
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
 * The resume form: its starting context is rebuilt from the original tree and a launch
 * worker-default is fixed at launch, so both are refused and carried as `undefined`/empty here
 * instead.
 */
export interface ResumeInvocation {
  kind: "resume";
  workflowPath: string;
  storeDir?: string;
  resumeRootRunId: string;
  /** `--from <run-id>`: the rerun boundary K; the CLI does zero K-logic and forwards it to
   * `Project`. */
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

// Operator launch-time config via CLI flags and/or a config file (spec §3): `--config` loads a
// whole object, repeatable `--set key=value` overrides top-level keys, both merging over file
// defaults.
export function parseRunInvocation(argv: string[]): RunInvocationResult {
  // `-C <dir>` can appear anywhere, so it is stripped before the positional is taken. Absent means
  // the store defaults to the workflow file's own directory.
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
      // mid-run failure; registry-relative validity is the launch-boundary check, not this shape
      // check.
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

  // A resumed run's context is rebuilt from the original tree, so a supplied seed is refused
  // outright rather than silently discarded.
  if (resumeRootRunId !== undefined && (contextFile !== undefined || setContextPairs.length > 0)) {
    return {
      success: false,
      error: `--context/--set-context cannot be combined with --resume: a resumed run's context is rebuilt from the original tree\n${RUN_USAGE}`,
    };
  }

  // A launch worker-default is fixed at launch and identity-defining, so supplying one with
  // `--resume` is refused rather than silently discarded — changing the worker is a new run, not a
  // resume.
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

  // `--list-eligible` is a dry-run of resume: it requires `--resume`, excludes `--from`, and
  // refuses the launch-only flags because it launches nothing.
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
    // `--context`/`--set-context` and `--worker-default` are already refused above whenever
    // `--resume` is set, so they cannot reach this block; the rest only configure a launch this
    // mode does not do.
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

// The engine-wide Processor cap (spec §5.5): ~400 MB per live processor, so this is the memory
// knob.
function parseProcessorConcurrency(value: string | undefined): PositiveIntResult {
  return parsePositiveInt("--processor-concurrency", value, RUN_USAGE);
}

type LogBackendsResult = { success: true; ids: LogBackendId[] } | { success: false; error: string };

// The engine-level `log.backends` setting: a comma-separated list; absent means both are on by
// default.
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
