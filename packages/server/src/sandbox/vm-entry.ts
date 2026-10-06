import { readFileSync, writeFileSync } from "node:fs";
import { type LogBackend, openProject } from "@path/engine";
import type { ConfigObject, JsonValue, WorkflowFile } from "@path/schema";

/**
 * What the host hands a run VM (ADR 0091), written as JSON to a mounted file. It holds no secret
 * values: those arrive as the VM's environment, and `secretNames` says which variables they are.
 */
export interface VmJob {
  rootRunId: string;
  /** The VM's own project: its `path.db` is the VM's, its `runs/<root>/` the host's mount. */
  projectDir: string;
  workflowDir: string;
  rootFile: WorkflowFile;
  files: [string, WorkflowFile][];
  /** Where the VM writes its exported rows at exit. */
  exportFile: string;
  secretNames: string[];
  input?: { [key: string]: JsonValue };
  operatorInput?: JsonValue;
  operatorConfig?: ConfigObject;
  launchWorkerDefaults?: { [stepType: string]: string };
  logBackends?: ("db" | "ndjson")[];
  processorConcurrency?: number;
  sourceWorkflowPath?: string;
}

/** One stdout line of the VM: a log event the host republishes live. */
export interface VmLine {
  event: unknown;
}

/**
 * Runs one job inside the VM: the whole root run, each log event written out as a line, then the
 * tree's rows exported. Resolves with the run's status.
 */
export async function runVmJob(
  job: VmJob,
  io: { env: NodeJS.ProcessEnv; writeLine: (line: string) => void; signal: AbortSignal },
): Promise<string> {
  const opened = openProject(job.projectDir);
  if (!opened.success) throw new Error(opened.error);
  const project = opened.project;
  const userSecrets: { [name: string]: string } = {};
  for (const name of job.secretNames) {
    const value = io.env[name];
    if (value !== undefined) userSecrets[name] = value;
  }
  const stdoutBackend: LogBackend = {
    async open() {},
    async write(event) {
      io.writeLine(JSON.stringify({ event } satisfies VmLine));
    },
    async close() {},
  };
  try {
    const result = await project.run(job.rootFile, job.workflowDir, {
      rootRunId: job.rootRunId,
      input: job.input,
      operatorInput: job.operatorInput,
      operatorConfig: job.operatorConfig,
      launchWorkerDefaults: job.launchWorkerDefaults,
      files: new Map(job.files),
      logBackends: job.logBackends,
      processorConcurrency: job.processorConcurrency,
      sourceWorkflowPath: job.sourceWorkflowPath,
      userSecrets,
      extraBackends: [stdoutBackend],
      signal: io.signal,
      warn: (message) => console.error(`warning: ${message}`),
    });
    writeFileSync(job.exportFile, JSON.stringify(project.archive.exportTree(job.rootRunId)));
    return result.status;
  } finally {
    project.close();
  }
}

/** The VM's process: `path-vm <job.json>`. SIGTERM cancels the run, which still exports. */
export async function vmMain(jobFile: string): Promise<void> {
  const job = JSON.parse(readFileSync(jobFile, "utf8")) as VmJob;
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  const status = await runVmJob(job, {
    env: process.env,
    writeLine: (line) => process.stdout.write(`${line}\n`),
    signal: controller.signal,
  });
  console.error(`run ${job.rootRunId} ${status}`);
}
