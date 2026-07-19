import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConfigObject } from "@path/schema";
import { loadWorkflowTree } from "./load-workflow-tree.js";
import { mergeConfig } from "./merge-config.js";
import { runWorkflow } from "./run-workflow.js";

export interface CliIo {
  log(message: string): void;
  error(message: string): void;
}

const consoleIo: CliIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

const USAGE = "usage: path run <workflow.json> [--config <config.json>] [--set key=value]...";

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
  if (!workflowPath) return { success: false, error: USAGE };

  let configFile: string | undefined;
  const setPairs: [string, string][] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--config") {
      const value = rest[i + 1];
      if (!value) return { success: false, error: `--config requires a path argument\n${USAGE}` };
      configFile = value;
      i += 1;
    } else if (flag === "--set") {
      const pair = rest[i + 1];
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) return { success: false, error: `--set requires a key=value argument\n${USAGE}` };
      setPairs.push([pair.slice(0, eq), pair.slice(eq + 1)]);
      i += 1;
    } else {
      return { success: false, error: `unrecognized argument "${flag}"\n${USAGE}` };
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

/** Runs the CLI and returns the process exit code — never calls process.exit itself. */
export async function main(argv: string[], io: CliIo = consoleIo): Promise<number> {
  const [command, ...rest] = argv;

  if (command !== "run") {
    io.error(USAGE);
    return 2;
  }

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

  const runResult = await runWorkflow(rootFile, dirname(tree.rootPath), { operatorConfig: operatorConfig.config });
  if (runResult.status === "failed") {
    io.error(`run failed: ${runResult.error}`);
    return 1;
  }

  io.log(typeof runResult.output === "string" ? runResult.output : JSON.stringify(runResult.output));
  return 0;
}
