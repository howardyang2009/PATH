import { dirname } from "node:path";
import { loadWorkflowTree } from "./load-workflow-tree.js";
import { runWorkflow } from "./run-workflow.js";

export interface CliIo {
  log(message: string): void;
  error(message: string): void;
}

const consoleIo: CliIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

const USAGE = "usage: path run <workflow.json>";

/** Runs the CLI and returns the process exit code — never calls process.exit itself. */
export async function main(argv: string[], io: CliIo = consoleIo): Promise<number> {
  const [command, workflowPath] = argv;

  if (command !== "run" || !workflowPath) {
    io.error(USAGE);
    return 2;
  }

  const loadResult = loadWorkflowTree(workflowPath);
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

  const runResult = await runWorkflow(rootFile, dirname(tree.rootPath));
  if (runResult.status === "failed") {
    io.error(`run failed: ${runResult.error}`);
    return 1;
  }

  io.log(typeof runResult.output === "string" ? runResult.output : JSON.stringify(runResult.output));
  return 0;
}
