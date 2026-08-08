import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { RUN_STATUSES, type ConfigObject, type JsonValue, type RunStatus } from "@path/schema";
import { loadWorkflowTree } from "./load-workflow-tree.js";
import { isLogBackendId, LOG_BACKEND_IDS, type LogBackendId } from "./logging/backends.js";
import type { LlmWorker } from "./llm/llm-worker.js";
import { mergeConfig } from "./merge-config.js";
import { openProject, type ProjectRunOptions, type ResumeResult } from "./project.js";
import { openRunArchive, type ListRootsOptions } from "./run-archive.js";

export interface CliIo {
  log(message: string): void;
  error(message: string): void;
}

/**
 * Collaborators the CLI would otherwise construct itself. The acceptance run (#26) uses this to
 * drive the real pipeline — real workflow files, real git, real persistence and logging — with a
 * scripted LLM worker in place of a live Agent SDK processor, which is the one collaborator that
 * costs money and never answers the same way twice.
 */
export interface RunOverrides {
  /** Where `prompt` steps execute; defaults to the pinned Agent SDK worker (mvp spec §7). */
  llmWorker?: LlmWorker;
  /**
   * How a forced second `^C` leaves the process (#53) — defaults to `process.exit(130)`. The one
   * place the CLI exits abruptly, and only because the operator asked twice; tests substitute their
   * own rather than taking the test process down to assert it.
   */
  forceExit?: (code: number) => void;
}

const consoleIo: CliIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

const RUN_USAGE =
  "usage: path run <workflow.json> [--resume <root-run-id>] [--config <config.json>] [--set key=value]... [--context <context.json>] [--set-context key=value]... [--log-backends db,ndjson] [--llm-concurrency <n>]";
const RUNS_USAGE =
  "usage: path runs [--limit <n>] [--status <status>] | path runs rm [--force] <root-run-id> | path runs prune";

interface ParsedRunArgs {
  workflowPath: string;
  resumeRootRunId?: string;
  configFile?: string;
  setPairs: [string, string][];
  contextFile?: string;
  setContextPairs: [string, string][];
  logBackends?: LogBackendId[];
  llmConcurrency?: number;
}

type ParseResult = { success: true; args: ParsedRunArgs } | { success: false; error: string };

// Operator launch-time config via CLI flags and/or a config file (spec §3): `--config <file>`
// loads a whole object, repeatable `--set key=value` overrides individual top-level keys —
// both merge over the top-level file's config defaults, nearest wins (format doc §8).
function parseRunArgs(argv: string[]): ParseResult {
  const [workflowPath, ...rest] = argv;
  if (!workflowPath) return { success: false, error: RUN_USAGE };

  let resumeRootRunId: string | undefined;
  let configFile: string | undefined;
  const setPairs: [string, string][] = [];
  let contextFile: string | undefined;
  const setContextPairs: [string, string][] = [];
  let logBackends: LogBackendId[] | undefined;
  let llmConcurrency: number | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--resume") {
      const value = rest[i + 1];
      if (!value) return { success: false, error: `--resume requires a root run id argument\n${RUN_USAGE}` };
      resumeRootRunId = value;
      i += 1;
    } else if (flag === "--config") {
      const value = rest[i + 1];
      if (!value) return { success: false, error: `--config requires a path argument\n${RUN_USAGE}` };
      configFile = value;
      i += 1;
    } else if (flag === "--set") {
      const pair = rest[i + 1];
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) return { success: false, error: `--set requires a key=value argument\n${RUN_USAGE}` };
      setPairs.push([pair.slice(0, eq), pair.slice(eq + 1)]);
      i += 1;
    } else if (flag === "--context") {
      const value = rest[i + 1];
      if (!value) return { success: false, error: `--context requires a path argument\n${RUN_USAGE}` };
      contextFile = value;
      i += 1;
    } else if (flag === "--set-context") {
      const pair = rest[i + 1];
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) return { success: false, error: `--set-context requires a key=value argument\n${RUN_USAGE}` };
      setContextPairs.push([pair.slice(0, eq), pair.slice(eq + 1)]);
      i += 1;
    } else if (flag === "--log-backends") {
      const value = rest[i + 1];
      const parsed = parseLogBackends(value);
      if (!parsed.success) return parsed;
      logBackends = parsed.ids;
      i += 1;
    } else if (flag === "--llm-concurrency") {
      const value = rest[i + 1];
      const parsed = parseLlmConcurrency(value);
      if (!parsed.success) return parsed;
      llmConcurrency = parsed.value;
      i += 1;
    } else {
      return { success: false, error: `unrecognized argument "${flag}"\n${RUN_USAGE}` };
    }
  }

  // A resumed run's starting context is already fully determined by restore-by-load from the
  // original tree (ADR 0003) — a supplied `--context`/`--set-context` seed has nothing to do but be
  // silently discarded or fought over, so combining either with `--resume` is refused outright
  // rather than quietly dropped (this repo treats silently-discarded operator state as a failure).
  if (resumeRootRunId !== undefined && (contextFile !== undefined || setContextPairs.length > 0)) {
    return {
      success: false,
      error: `--context/--set-context cannot be combined with --resume: a resumed run's context is restored from the original tree\n${RUN_USAGE}`,
    };
  }

  return {
    success: true,
    args: { workflowPath, resumeRootRunId, configFile, setPairs, contextFile, setContextPairs, logBackends, llmConcurrency },
  };
}

type PositiveIntResult = { success: true; value: number } | { success: false; error: string };

// The one positive-integer flag check, shared by `--llm-concurrency`'s memory cap and `runs`'
// `--limit` page size (#174). `flag`/`usage` name the offending flag and its command's usage, so the
// two call sites can't drift on the wording the way two copy-pasted checks eventually would.
function parsePositiveInt(flag: string, value: string | undefined, usage: string): PositiveIntResult {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed <= 0) {
    return { success: false, error: `${flag} requires a positive integer\n${usage}` };
  }
  return { success: true, value: parsed };
}

// The engine-wide LLM processor cap (mvp spec §5.5, §7): a positive integer overriding the default
// of 4. The ceiling is memory (~400 MB per live processor), so this is the operator's memory knob.
function parseLlmConcurrency(value: string | undefined): PositiveIntResult {
  return parsePositiveInt("--llm-concurrency", value, RUN_USAGE);
}

type LogBackendsResult = { success: true; ids: LogBackendId[] } | { success: false; error: string };

// The engine-level `log.backends` setting (mvp spec §8.2): a comma-separated list of backend ids.
// `--log-backends none` selects no backends; when the flag is absent, both are on by default.
function parseLogBackends(value: string | undefined): LogBackendsResult {
  if (!value) return { success: false, error: `--log-backends requires a value\n${RUN_USAGE}` };
  if (value === "none") return { success: true, ids: [] };

  const ids: LogBackendId[] = [];
  for (const raw of value.split(",")) {
    const id = raw.trim();
    if (!isLogBackendId(id)) {
      return { success: false, error: `--log-backends: unknown backend "${id}" (choose from ${LOG_BACKEND_IDS.join(", ")}, or "none")` };
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { success: true, ids };
}

type ConfigResult = { success: true; config: ConfigObject } | { success: false; error: string };

// Shared by `--config`/`--set` and `--context`/`--set-context` (ADR 0003: "one merge algorithm
// serves both flag pairs"): a whole-object file loads first, then repeatable `key=value` pairs
// override individual top-level keys, each JSON.parse-or-raw-string-fallback, nearest-wins via
// `mergeConfig`. `fileFlag`/`pairFlag` name the flags in error messages, so the two call sites can't
// drift on validation wording the way two copy-pasted functions eventually would.
function buildKeyedConfig(
  fileFlag: string,
  file: string | undefined,
  pairFlag: string,
  pairs: [string, string][],
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

function buildOperatorConfig(args: ParsedRunArgs): ConfigResult {
  return buildKeyedConfig("--config", args.configFile, "--set", args.setPairs);
}

type ContextResult =
  | { success: true; context: { [key: string]: JsonValue } }
  | { success: false; error: string };

// The starting-context seed for a fresh (non-`--resume`) run (ADR 0003), feeding `RunOptions.input`
// instead of operator config.
function buildContextSeed(args: ParsedRunArgs): ContextResult {
  const result = buildKeyedConfig("--context", args.contextFile, "--set-context", args.setContextPairs);
  if (!result.success) return result;

  // A context seed is plain JSON data (format doc §6.3) — never `$secret`/`$env` wrappers, which are
  // a `config`-only concept (spec §8.3). `--context`/`--set-context` only ever produce plain JSON
  // values, so this narrowing is exact, not a runtime assumption.
  return { success: true, context: result.config as { [key: string]: JsonValue } };
}

// Death by SIGINT, the shell convention (128 + 2) — a cancelled run is neither a failed one (1)
// nor a usage error (2), and a forced second `^C` leaves on the same code it interrupted.
const SIGINT_EXIT_CODE = 130;

interface SigintCancellation {
  /** Handed to `RunOptions.signal`: the operator's way into the engine's own unwind (#52). */
  signal: AbortSignal;
  /** Removes the listener — the CLI owns the process signal only while a run is in flight. */
  dispose(): void;
}

/**
 * Makes `^C` truthful (#53): the first press *cancels the run* rather than killing the process, so
 * the run unwinds the engine's normal way — in-flight leaf killed, `run-cancelled` with
 * `cause: "operator"`, the root's terminal `step-finished` written, backends closed, row
 * `cancelled`.
 *
 * Cancellation is best-effort and holds no deadline (mvp spec §5.6), so the operator needs an
 * escape hatch from a slow unwind: a second press exits immediately, which is what pressing `^C`
 * twice already means. That is the only path where the CLI exits by itself — the graceful one
 * returns an exit code like every other command (`main` never calls `process.exit`).
 */
function cancelOnSigint(io: CliIo, forceExit: (code: number) => void): SigintCancellation {
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) {
      forceExit(SIGINT_EXIT_CODE);
      return;
    }
    // Naming the cost at the moment the operator is deciding whether to press again (#60): forcing
    // abandons the unwind, so the rows keep whatever status they last held and nothing later fixes
    // them. `path runs rm` is the remedy, and saying so here is cheaper than being asked.
    io.error("cancelling… (Ctrl-C again to force — leaves the run's rows `running`; clear with `path runs rm`)");
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
  const parsed = parseRunArgs(rest);
  if (!parsed.success) {
    io.error(parsed.error);
    return 2;
  }

  const operatorConfig = buildOperatorConfig(parsed.args);
  if (!operatorConfig.success) {
    io.error(operatorConfig.error);
    return 2;
  }

  const contextSeed = buildContextSeed(parsed.args);
  if (!contextSeed.success) {
    io.error(contextSeed.error);
    return 2;
  }

  const loadResult = loadWorkflowTree(parsed.args.workflowPath);
  if (!loadResult.success) {
    io.error(loadResult.errors.join("\n"));
    return 1;
  }

  const { tree } = loadResult;
  // Whole-tree validation happened above; execution starts at the root file and follows
  // `workflow` step refs into the rest of the tree (#22) via `runWorkflow`'s `files` option.
  const rootFile = tree.files.get(tree.rootPath);
  if (!rootFile) {
    io.error(`internal error: root file "${tree.rootPath}" missing from loaded tree`);
    return 1;
  }

  // The CLI's project directory *is* the workflow file's own directory — it runs one file, in
  // place. The server, serving a whole project, must tell them apart (#59); `Project.run` takes
  // both so neither caller can conflate them.
  const workflowDir = dirname(tree.rootPath);
  const opened = openProject(workflowDir);
  if (!opened.success) {
    io.error(opened.error);
    // A malformed engine-settings file is an operator mistake, like a bad flag; an unopenable db
    // is not.
    return opened.kind === "settings" ? 2 : 1;
  }
  const project = opened.project;

  // Installed only for the run itself, and removed the moment it settles — see cancelOnSigint.
  const sigint = cancelOnSigint(io, overrides.forceExit ?? ((code) => process.exit(code)));

  // The backend list, the observer pair and their order, and settings precedence all belong to the
  // project (#64). What is left here is what a CLI actually owns: the flags it parsed, the signal it
  // installed, and where warnings go. `input` is the fresh-run context seed only — a resumed run
  // restores its context from the original tree instead, so `resume` never carries an `input`.
  const projectOptions: ProjectRunOptions = {
    operatorConfig: operatorConfig.config,
    files: tree.files,
    logBackends: parsed.args.logBackends,
    llmConcurrency: parsed.args.llmConcurrency,
    llmWorker: overrides.llmWorker,
    warn: (message) => io.error(`warning: ${message}`),
    signal: sigint.signal,
  };

  if (parsed.args.resumeRootRunId !== undefined) {
    let resumeResult: ResumeResult;
    try {
      resumeResult = await project.resume(rootFile, parsed.args.resumeRootRunId, workflowDir, projectOptions);
    } finally {
      sigint.dispose();
      project.close();
    }
    return reportResume(resumeResult, io);
  }

  let runResult;
  try {
    runResult = await project.run(rootFile, workflowDir, { ...projectOptions, input: contextSeed.context });
  } finally {
    sigint.dispose();
    project.close();
  }

  // A fresh run prints its output on success; a cancelled/failed one has no output contract.
  if (runResult.status === "succeeded") {
    io.log(typeof runResult.output === "string" ? runResult.output : JSON.stringify(runResult.output));
    return 0;
  }
  return reportOutcome(runResult.status, runResult.error, io);
}

// Maps a settled run's terminal status to its stderr narration and exit code, shared by fresh and
// resumed runs (#177) so the two can't drift on how a cancel or failure reads. `cancelled` (the
// unwind the operator's `^C` was owed) and `failed` narrate identically for both; success returns 0
// and prints nothing, leaving each caller to own its happy-path output — a fresh run prints the
// workflow output, a resumed run has already printed the successor's root run id.
function reportOutcome(status: RunStatus, error: string | undefined, io: CliIo): number {
  if (status === "cancelled") {
    io.error("run cancelled");
    return SIGINT_EXIT_CODE;
  }
  if (status === "failed") {
    io.error(`run failed: ${error}`);
    return 1;
  }
  return 0;
}

// A resumed run's CLI outcome (#177). An unknown root run id is an ordinary operator mistake — a
// typo — so it exits 1 with the engine's own "no run found" message, never silently doing something
// else. Otherwise the successor's fresh root run id is printed on *every* outcome (succeeded,
// failed, cancelled alike), so the operator can inspect it or chain a further `--resume` regardless
// of how it ended; the exit code and any error/cancel message then mirror a fresh run's.
function reportResume(result: ResumeResult, io: CliIo): number {
  if (!result.found) {
    io.error(result.error);
    return 1;
  }

  io.log(result.rootRunId);
  return reportOutcome(result.status, result.error, io);
}

type ListRootsArgsResult = { success: true; options: ListRootsOptions } | { success: false; error: string };

// The bare `path runs` listing (#174) reuses the same `--limit`/`--status` filters `listRoots`
// already implements, validated here the way `run`'s flags are — `--status` against the domain's own
// status set, so an unknown status is refused rather than silently matching nothing.
function parseRunsListArgs(args: string[]): ListRootsArgsResult {
  let limit: number | undefined;
  let status: RunStatus | undefined;

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
        return { success: false, error: `--status requires one of ${RUN_STATUSES.join(", ")}\n${RUNS_USAGE}` };
      }
      status = value as RunStatus;
      i += 1;
    } else {
      return { success: false, error: `unrecognized argument "${flag}"\n${RUNS_USAGE}` };
    }
  }

  return { success: true, options: { limit, status } };
}

const RUNS_TABLE_HEADERS = ["root run id", "status", "resumed-from"] as const;

// Space-aligned columns (#174): the root run id is never truncated, so its column is as wide as the
// longest id on the page. Every column but the last is padded to its width; the last carries no
// trailing padding.
function formatRunsTable(rows: readonly [string, string, string][]): string {
  const widths = RUNS_TABLE_HEADERS.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => row[col]!.length)),
  );
  const line = (cols: readonly string[]): string =>
    cols.map((cell, col) => (col < cols.length - 1 ? cell.padEnd(widths[col]!) : cell)).join("  ");
  return [line(RUNS_TABLE_HEADERS), ...rows.map(line)].join("\n");
}

// `path runs` with no subcommand (#174): the first listing surface, over the same query `rm`/`prune`
// operate on. The `resumed-from` cell asks the archive which predecessor ids still have rows —
// existence, not presence on this page, is what tells a live predecessor from a `(deleted)` one.
function runRunsListCommand(args: string[], io: CliIo): number {
  const parsed = parseRunsListArgs(args);
  if (!parsed.success) {
    io.error(parsed.error);
    return 2;
  }

  const opened = openRunArchive(process.cwd());
  if (!opened.success) {
    io.error(opened.error);
    return 1;
  }
  try {
    const roots = opened.archive.listRoots(parsed.options);
    const predecessorIds = roots
      .map((run) => run.resumedFromRootRunId)
      .filter((id): id is string => id !== null);
    const live = opened.archive.existingRunIds(predecessorIds);

    const rows = roots.map((run): [string, string, string] => {
      const predecessor = run.resumedFromRootRunId;
      const resumedFrom =
        predecessor === null ? "-" : live.has(predecessor) ? predecessor : `${predecessor} (deleted)`;
      return [run.runId, run.status, resumedFrom];
    });

    io.log(formatRunsTable(rows));
  } finally {
    opened.close();
  }

  return 0;
}

// `path runs rm`/`path runs prune` take no workflow-file argument (mvp spec §3) — they operate
// on the `.path/` found in the current working directory, like `git` subcommands operate on
// whatever repo the cwd is inside.
async function runRunsCommand(args: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand === "rm") {
    // `--force` overrides the live-reuse-marker block (#175). Splitting flags from operands keeps the
    // existing "exactly one id" check counting ids, not the flag — `rm --force <id>` and `rm <id>`
    // both carry one operand.
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
    // One id, not a list: a second operand used to be dropped in silence, so an operator who typed
    // two ids watched one run survive a command they believed had removed it (#61).
    if (operands.length > 1) {
      io.error(`runs rm takes exactly one run id, got ${operands.length}\n${RUNS_USAGE}`);
      return 2;
    }

    const opened = openRunArchive(process.cwd());
    if (!opened.success) {
      io.error(opened.error);
      return 1;
    }
    try {
      // The guard reads before deleting: a live successor tree still reusing this tree's data blocks
      // the delete by default, so `rm` never silently strands a reference a later resume or cost
      // query would read from (#175). An id with no rows has no blockers, so a not-found id still
      // falls through to `remove`'s own "no run found" below rather than being masked by the guard.
      const blockers = opened.archive.blockingSuccessors(rootRunId);
      if (blockers.length > 0 && !force) {
        io.error(
          `refusing to remove ${rootRunId}: live successor run(s) reuse its data: ${blockers.join(", ")}\n` +
            `re-run with --force to delete it anyway — those successors would keep a dangling reference`,
        );
        return 1;
      }
      // "Found" means either store held something — an orphaned directory with no rows still
      // counts, so `rm` finishes a half-done cleanup rather than reporting "not found" while
      // deleting it anyway. Which stores there are, and that they go together (mvp spec §6), is
      // the archive's business.
      if (!opened.archive.remove(rootRunId)) {
        io.error(`no run found with id "${rootRunId}"`);
        return 1;
      }
      io.log(`removed run ${rootRunId}`);
      // `--force` deletes exactly the named tree, no cascade — so the successors it just orphaned are
      // named here (they were blockers until the delete landed), or the dangling reference stays
      // invisible until something later reads through it.
      if (blockers.length > 0) {
        io.log(`orphaned successor run(s): ${blockers.join(", ")}`);
      }
    } finally {
      opened.close();
    }

    return 0;
  }

  if (subcommand === "prune") {
    // `prune` takes no operands, and used to ignore whatever followed it — so `runs prune --help`,
    // asked by someone who wanted to know what it does, deleted every run in the project instead of
    // answering (#61). A destructive verb must be at least as strict about its input as `run` is.
    if (rest.length > 0) {
      io.error(`runs prune takes no arguments, got "${rest[0]!}"\n${RUNS_USAGE}`);
      return 2;
    }

    const opened = openRunArchive(process.cwd());
    if (!opened.success) {
      io.error(opened.error);
      return 1;
    }
    let deleted: number;
    try {
      deleted = opened.archive.prune();
    } finally {
      opened.close();
    }

    io.log(`pruned ${deleted} run(s)`);
    return 0;
  }

  // No subcommand, or a leading flag — the bare listing (#174). A word that is neither `rm`, `prune`
  // nor a flag is a mistyped subcommand, and still earns the usage error.
  if (subcommand === undefined || subcommand.startsWith("--")) {
    return runRunsListCommand(args, io);
  }

  io.error(RUNS_USAGE);
  return 2;
}

/** Runs the CLI and returns the process exit code — never calls process.exit itself. */
export async function main(argv: string[], io: CliIo = consoleIo, overrides: RunOverrides = {}): Promise<number> {
  const [command, ...rest] = argv;

  // Help is answered here, before dispatch, so it can never reach a subcommand and be mistaken for
  // an operand. There was no help flag at all until #61, which is exactly why `runs prune --help`
  // was a plausible thing to type — and, until the same ticket, a destructive one.
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
