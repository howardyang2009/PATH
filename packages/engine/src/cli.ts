import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import type { ConfigObject } from "@path/schema";
import { loadWorkflowTree } from "./load-workflow-tree.js";
import { mergeConfig } from "./merge-config.js";
import { dirExists, removeDir } from "./persistence/blob-store.js";
import { openDb, SchemaVersionError } from "./persistence/db.js";
import { ensurePathDirGitignore } from "./persistence/gitignore.js";
import { dbFilePath, pathDir, rootRunTreeDir, runsDir } from "./persistence/paths.js";
import { createPersistedObserver } from "./persistence/persisted-observer.js";
import { deleteAllRuns, deleteRunsForRoot } from "./persistence/run-store.js";
import { runWorkflow } from "./run-workflow.js";

export interface CliIo {
  log(message: string): void;
  error(message: string): void;
}

const consoleIo: CliIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

const RUN_USAGE = "usage: path run <workflow.json> [--config <config.json>] [--set key=value]...";
const RUNS_USAGE = "usage: path runs rm <root-run-id> | path runs prune";

interface ParsedRunArgs {
  workflowPath: string;
  configFile?: string;
  setPairs: [string, string][];
}

type ParseResult = { success: true; args: ParsedRunArgs } | { success: false; error: string };

// Operator launch-time config via CLI flags and/or a config file (spec §3): `--config <file>`
// loads a whole object, repeatable `--set key=value` overrides individual top-level keys —
// both merge over the top-level file's config defaults, nearest wins (format doc §8).
function parseRunArgs(argv: string[]): ParseResult {
  const [workflowPath, ...rest] = argv;
  if (!workflowPath) return { success: false, error: RUN_USAGE };

  let configFile: string | undefined;
  const setPairs: [string, string][] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--config") {
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
    } else {
      return { success: false, error: `unrecognized argument "${flag}"\n${RUN_USAGE}` };
    }
  }

  return { success: true, args: { workflowPath, configFile, setPairs } };
}

type ConfigResult = { success: true; config: ConfigObject } | { success: false; error: string };

function buildOperatorConfig(args: ParsedRunArgs): ConfigResult {
  let config: ConfigObject = {};

  if (args.configFile) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(args.configFile, "utf8"));
    } catch (err) {
      return {
        success: false,
        error: `cannot read --config file "${args.configFile}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { success: false, error: `--config file "${args.configFile}" must contain a JSON object` };
    }
    config = mergeConfig(config, raw as ConfigObject);
  }

  for (const [key, value] of args.setPairs) {
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

type OpenDbResult = { success: true; db: Database.Database } | { success: false; error: string };

function openDbOrReport(dbFile: string): OpenDbResult {
  try {
    return { success: true, db: openDb(dbFile) };
  } catch (err) {
    const error = err instanceof SchemaVersionError ? err.message : `cannot open .path/path.db: ${String(err)}`;
    return { success: false, error };
  }
}

async function runRunCommand(rest: string[], io: CliIo): Promise<number> {
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

  const loadResult = loadWorkflowTree(parsed.args.workflowPath);
  if (!loadResult.success) {
    io.error(loadResult.errors.join("\n"));
    return 1;
  }

  const { tree } = loadResult;
  // Whole-tree validation happened above; the walking skeleton only executes the root file.
  const rootFile = tree.files.get(tree.rootPath);
  if (!rootFile) {
    io.error(`internal error: root file "${tree.rootPath}" missing from loaded tree`);
    return 1;
  }

  const projectDir = dirname(tree.rootPath);
  ensurePathDirGitignore(pathDir(projectDir));

  const opened = openDbOrReport(dbFilePath(projectDir));
  if (!opened.success) {
    io.error(opened.error);
    return 1;
  }

  let runResult;
  try {
    const observer = createPersistedObserver(opened.db, projectDir);
    runResult = await runWorkflow(rootFile, projectDir, { operatorConfig: operatorConfig.config, observer });
  } finally {
    opened.db.close();
  }

  if (runResult.status === "failed") {
    io.error(`run failed: ${runResult.error}`);
    return 1;
  }

  io.log(typeof runResult.output === "string" ? runResult.output : JSON.stringify(runResult.output));
  return 0;
}

// `path runs rm`/`path runs prune` take no workflow-file argument (mvp spec §3) — they operate
// on the `.path/` found in the current working directory, like `git` subcommands operate on
// whatever repo the cwd is inside.
async function runRunsCommand(args: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = args;
  const projectDir = process.cwd();
  const dbFile = dbFilePath(projectDir);

  if (subcommand === "rm") {
    const rootRunId = rest[0];
    if (!rootRunId) {
      io.error(RUNS_USAGE);
      return 2;
    }

    // An id is "found" if either store has something for it — an orphaned directory with no db
    // rows (e.g. left by a prior half-finished cleanup) still counts, so `rm` can finish the job
    // rather than reporting "not found" while silently deleting it anyway.
    const treeDir = rootRunTreeDir(projectDir, rootRunId);
    const dirExisted = dirExists(treeDir);

    let deleted = 0;
    if (existsSync(dbFile)) {
      const opened = openDbOrReport(dbFile);
      if (!opened.success) {
        io.error(opened.error);
        return 1;
      }
      deleted = deleteRunsForRoot(opened.db, rootRunId);
      opened.db.close();
    }

    if (deleted === 0 && !dirExisted) {
      io.error(`no run found with id "${rootRunId}"`);
      return 1;
    }

    // Rows and directory are deleted together (mvp spec §6) so the two stores never drift.
    removeDir(treeDir);
    io.log(`removed run ${rootRunId}`);
    return 0;
  }

  if (subcommand === "prune") {
    let deleted = 0;
    if (existsSync(dbFile)) {
      const opened = openDbOrReport(dbFile);
      if (!opened.success) {
        io.error(opened.error);
        return 1;
      }
      deleted = deleteAllRuns(opened.db);
      opened.db.close();
    }
    // Always remove the runs tree, even if the db was already missing — an orphaned directory
    // shouldn't survive a prune just because its rows happened to be gone already.
    removeDir(runsDir(projectDir));

    io.log(`pruned ${deleted} run(s)`);
    return 0;
  }

  io.error(RUNS_USAGE);
  return 2;
}

/** Runs the CLI and returns the process exit code — never calls process.exit itself. */
export async function main(argv: string[], io: CliIo = consoleIo): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "run") {
    return runRunCommand(rest, io);
  }
  if (command === "runs") {
    return runRunsCommand(rest, io);
  }

  io.error(`${RUN_USAGE}\n${RUNS_USAGE}`);
  return 2;
}
