import { readFileSync, writeFileSync } from "node:fs";
import { type CompleteResult, type LogBackend, openProject, type Project } from "@path/engine";
import type { ConfigObject, JsonValue, WorkflowFile } from "@path/schema";

/** What one VM invocation does (ADR 0091): a fresh launch, a Resume successor, or a Complete. */
export type VmOperation =
  | {
      kind: "start";
      input?: { [key: string]: JsonValue };
      operatorInput?: JsonValue;
      launchWorkerDefaults?: { [stepType: string]: string };
    }
  | { kind: "resume"; predecessorRootRunId: string; rerunFromRunId?: string }
  | { kind: "complete"; stepRunId: string; output: JsonValue };

/**
 * What the host hands a run VM, written as JSON to a mounted file. It holds no secret values:
 * those arrive as the VM's environment, and `secretNames` says which variables they are.
 */
export interface VmJob {
  operation: VmOperation;
  /** The tree this invocation writes and exports: a new root, or the completed one. */
  rootRunId: string;
  /** The VM's own project, on a host mount so its `path.db` survives a lost VM. */
  projectDir: string;
  workflowDir: string;
  rootFile: WorkflowFile;
  files: [string, WorkflowFile][];
  /** Trees the VM's store starts with, as `RunArchive.exportTree` wrote them. */
  copyIn: { rootRunId: string; tree: unknown }[];
  /** Where the VM writes the tree's exported rows at exit. */
  exportFile: string;
  /** Where the VM writes a Complete's result. */
  resultFile: string;
  secretNames: string[];
  operatorConfig?: ConfigObject;
  logBackends?: ("db" | "ndjson")[];
  processorConcurrency?: number;
  sourceWorkflowPath?: string;
}

/** One stdout line of the VM: a log event the host republishes live. */
export interface VmLine {
  event: unknown;
}

interface VmIo {
  env: NodeJS.ProcessEnv;
  writeLine: (line: string) => void;
  signal: AbortSignal;
}

/**
 * Runs one job inside the VM: copies in the trees it needs, drives its operation with each log event
 * written out as a line, then exports the tree. Resolves with the run's status.
 */
export async function runVmJob(job: VmJob, io: VmIo): Promise<string> {
  const opened = openProject(job.projectDir);
  if (!opened.success) throw new Error(opened.error);
  const project = opened.project;
  try {
    for (const { rootRunId, tree } of job.copyIn) {
      const copied = project.archive.importTree(rootRunId, tree);
      if (!copied.ok) throw new Error(`copy-in of ${rootRunId}: ${copied.error}`);
    }
    const status = await drive(project, job, io);
    writeFileSync(job.exportFile, JSON.stringify(project.archive.exportTree(job.rootRunId)));
    return status;
  } finally {
    project.close();
  }
}

async function drive(project: Project, job: VmJob, io: VmIo): Promise<string> {
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
  const shared = {
    files: new Map(job.files),
    operatorConfig: job.operatorConfig,
    logBackends: job.logBackends,
    processorConcurrency: job.processorConcurrency,
    userSecrets,
    extraBackends: [stdoutBackend],
    signal: io.signal,
    warn: (message: string) => console.error(`warning: ${message}`),
  };
  const { operation } = job;
  if (operation.kind === "start") {
    const result = await project.run(job.rootFile, job.workflowDir, {
      ...shared,
      rootRunId: job.rootRunId,
      input: operation.input,
      operatorInput: operation.operatorInput,
      launchWorkerDefaults: operation.launchWorkerDefaults,
      sourceWorkflowPath: job.sourceWorkflowPath,
    });
    return result.status;
  }
  if (operation.kind === "resume") {
    const result = await project.resume(
      job.rootFile,
      operation.predecessorRootRunId,
      job.workflowDir,
      {
        ...shared,
        rootRunId: job.rootRunId,
        rerunFromRunId: operation.rerunFromRunId,
        sourceWorkflowPath: job.sourceWorkflowPath,
      },
    );
    return result.found ? result.status : "failed";
  }
  const result: CompleteResult = await project.complete(
    job.rootFile,
    operation.stepRunId,
    operation.output,
    job.workflowDir,
    shared,
  );
  writeFileSync(job.resultFile, JSON.stringify(result));
  return result.ok ? result.status : result.reason;
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
