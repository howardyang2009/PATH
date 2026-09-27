import { type CliIo, consoleIo, type RunOverrides } from "./io.js";
import { RUN_USAGE } from "./parse-run.js";
import { runRunCommand } from "./run-command.js";
import { RUNS_USAGE, runRunsCommand } from "./runs-command.js";

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
