import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { type Project, pathDir, type RunTreeExport, rootRunTreeDir } from "@path/engine";
import { type LogEvent, LogEventSchema, type RunStatus } from "@path/schema";
import type { LiveRuns, StartRunOptions } from "../live-runs.js";
import { RunEventHub, streamRun } from "../run-event-hub.js";
import type { SandboxMount, SandboxProcess, SandboxRuntime } from "./sandbox-runtime.js";
import type { VmJob, VmLine } from "./vm-entry.js";
import type { VmSlots } from "./vm-slots.js";

/** How hosted runs reach their VMs (ADR 0091). One per Server: `slots` is shared by every user. */
export interface SandboxOptions {
  runtime: SandboxRuntime;
  slots: VmSlots;
  /** The run image; its entrypoint takes the job file as its one argument. */
  image: string;
  cpus: number;
  memoryMiB: number;
  /** Wall time per VM; past it the engine is asked to stop, and the VM is killed `stopGraceMs`
   * later. */
  timeoutMs: number;
  stopGraceMs: number;
  maxExportBytes: number;
  maxBlobBytes: number;
  network?: string;
  /** The host variables every VM receives beside the launcher's secrets. */
  hostEnv: { [name: string]: string };
}

export const SANDBOX_LIMITS = {
  cpus: 4,
  memoryMiB: 4096,
  timeoutMs: 60 * 60 * 1000,
  stopGraceMs: 10_000,
  maxVms: 3,
  maxExportBytes: 64 * 1024 * 1024,
  maxBlobBytes: 1024 * 1024 * 1024,
} as const;

/** One launch this store holds, queued or in a VM. */
interface Launch {
  cancel(): void;
}

/**
 * `LiveRuns` for hosted mode (ADR 0091): each Start runs the whole root run in a fresh VM. The
 * host keeps the record: it writes a `pending` root row at once, republishes the VM's events live
 * and replaces that row with the VM's validated export at exit.
 */
export function createSandboxedRuns(store: Project, sandbox: SandboxOptions): LiveRuns {
  const hub = new RunEventHub();
  const launches = new Map<string, Launch>();
  /** Each running root's events so far: the stored log arrives only with the export. */
  const streamed = new Map<string, LogEvent[]>();
  const inFlight = new Set<Promise<void>>();

  async function execute(rootRunId: string, job: VmJob, env: { [name: string]: string }) {
    let stopped = false;
    let vm: SandboxProcess | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      stopped = true;
      if (vm === undefined || killTimer !== undefined) return;
      vm.terminate();
      killTimer = setTimeout(() => vm?.kill(), sandbox.stopGraceMs);
    };
    const ticket = sandbox.slots.take();
    launches.set(rootRunId, {
      cancel: () => {
        ticket.cancel();
        stop();
      },
    });

    const release = await ticket.slot;
    if (release === null || stopped) {
      release?.();
      markRoot(store, rootRunId, job, "cancelled");
      return;
    }
    const staging = stagingDir(store, rootRunId);
    try {
      const mounts = prepareMounts(store, job, staging);
      const events: LogEvent[] = [];
      streamed.set(rootRunId, events);
      vm = sandbox.runtime.launch(
        {
          name: `path-run-${rootRunId}`,
          labels: { "path.sandbox": "run", "path.root-run-id": rootRunId },
          image: sandbox.image,
          command: [join(staging, "io", "job.json")],
          mounts,
          env,
          cpus: sandbox.cpus,
          memoryMiB: sandbox.memoryMiB,
          network: sandbox.network,
        },
        (line) => {
          const event = parseEventLine(line);
          // `seq` only grows, so a VM cannot rewrite what a Viewer already saw.
          if (event === undefined || event.seq <= (events.at(-1)?.seq ?? 0)) return;
          events.push(event);
          hub.publish(rootRunId, event);
        },
      );
      markRoot(store, rootRunId, job, "running");
      const timeout = setTimeout(stop, sandbox.timeoutMs);
      const code = await vm.exited;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      const failure =
        code === 0
          ? importVmExport(store, rootRunId, job, sandbox)
          : `sandbox exited with code ${code}`;
      if (failure !== undefined) {
        console.error(`run ${rootRunId}: ${failure}`);
        markRoot(store, rootRunId, job, "failed");
      }
    } finally {
      release();
      streamed.delete(rootRunId);
      rmSync(staging, { recursive: true, force: true });
    }
  }

  return {
    async start(rootFile, workflowDir, options): Promise<{ runId: string; rootRunId: string }> {
      const rootRunId = randomUUID();
      const job = vmJob(store, rootRunId, rootFile, workflowDir, options);
      markRoot(store, rootRunId, job, "pending");
      hub.open(rootRunId);
      const run = execute(rootRunId, job, {
        ...sandbox.hostEnv,
        ...(options.userSecrets ?? {}),
      })
        .catch((err) => {
          console.error(`run ${rootRunId} crashed: ${err instanceof Error ? err.stack : err}`);
          markRoot(store, rootRunId, job, "failed");
        })
        .finally(() => {
          launches.delete(rootRunId);
          hub.close(rootRunId);
          inFlight.delete(run);
        });
      inFlight.add(run);
      return { runId: rootRunId, rootRunId };
    },

    async resume() {
      throw new Error("Resume does not run in a sandbox yet");
    },

    async complete() {
      throw new Error("Complete does not run in a sandbox yet");
    },

    cancel(rootRunId) {
      const launch = launches.get(rootRunId);
      if (launch === undefined) return false;
      launch.cancel();
      return true;
    },

    stream(rootRunId, afterSeq, handlers) {
      // A running root's events are in memory; a settled root's in the store.
      const history = (after: number | undefined): LogEvent[] =>
        streamed.get(rootRunId)?.filter((event) => event.seq > (after ?? 0)) ??
        store.archive.tree(rootRunId)?.events(after) ??
        [];
      return streamRun(hub, history, rootRunId, afterSeq, handlers);
    },

    get cancellable() {
      return launches.size;
    },

    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

function stagingDir(store: Project, rootRunId: string): string {
  return join(pathDir(store.dir), "sandbox", rootRunId);
}

/** The job a VM runs. Paths are the ones the VM sees: its own project under the staging
 * directory, the workflow directories where they sit on the host. */
function vmJob(
  store: Project,
  rootRunId: string,
  rootFile: VmJob["rootFile"],
  workflowDir: string,
  options: StartRunOptions,
): VmJob {
  const staging = stagingDir(store, rootRunId);
  return {
    rootRunId,
    projectDir: join(staging, "project"),
    workflowDir,
    rootFile,
    files: [...options.files],
    exportFile: join(staging, "io", "export.json"),
    secretNames: Object.keys(options.userSecrets ?? {}),
    input: options.input,
    operatorInput: options.operatorInput,
    operatorConfig: options.operatorConfig,
    launchWorkerDefaults: options.launchWorkerDefaults,
    logBackends: options.logBackends,
    processorConcurrency: options.processorConcurrency,
    sourceWorkflowPath: options.sourceWorkflowPath,
  };
}

/** Writes the job file and returns what the VM mounts: the job directory, the root's blob
 * directory read-write, and every workflow file's directory read-only. */
function prepareMounts(store: Project, job: VmJob, staging: string): SandboxMount[] {
  const io = join(staging, "io");
  mkdirSync(io, { recursive: true });
  writeFileSync(join(io, "job.json"), JSON.stringify(job));
  const blobs = rootRunTreeDir(store.dir, job.rootRunId);
  mkdirSync(blobs, { recursive: true });

  const dirs = [job.workflowDir, ...job.files.map(([path]) => dirname(path))].sort();
  const workflowDirs = dirs.filter(
    (dir, i) => !dirs.slice(0, i).some((outer) => dir === outer || dir.startsWith(outer + sep)),
  );
  return [
    { hostPath: io, guestPath: io, readOnly: false },
    { hostPath: blobs, guestPath: rootRunTreeDir(job.projectDir, job.rootRunId), readOnly: false },
    ...workflowDirs.map((dir) => ({ hostPath: dir, guestPath: dir, readOnly: true })),
  ];
}

/** A VM stdout line as a log event, or `undefined` for any other output. */
function parseEventLine(line: string): LogEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const event = LogEventSchema.safeParse((parsed as Partial<VmLine> | null)?.event);
  return event.success ? event.data : undefined;
}

/** The host's own root row, used until the VM's export replaces it and when the VM leaves none. */
function markRoot(store: Project, rootRunId: string, job: VmJob, status: RunStatus): void {
  const now = new Date().toISOString();
  const terminal = status !== "pending" && status !== "running";
  const startedAt = store.archive.tree(rootRunId)?.root?.startedAt ?? now;
  const result = store.archive.importTree(rootRunId, {
    runs: [
      {
        run_id: rootRunId,
        root_run_id: rootRunId,
        parent_run_id: null,
        status,
        started_at: startedAt,
        finished_at: terminal ? now : null,
        workflow_id: job.rootFile.id ?? null,
        workflow_name: job.rootFile.name ?? null,
        workflow_path: job.sourceWorkflowPath ?? null,
      },
    ],
    events: [],
  } satisfies RunTreeExport);
  if (!result.ok) console.error(`run ${rootRunId}: ${result.error}`);
}

/** Imports the VM's export after removing every non-regular file it left in the blob directory.
 * Returns why the import was refused, or `undefined` once it landed. */
function importVmExport(
  store: Project,
  rootRunId: string,
  job: VmJob,
  sandbox: SandboxOptions,
): string | undefined {
  const blobBytes = scrubBlobs(rootRunTreeDir(store.dir, rootRunId));
  if (blobBytes > sandbox.maxBlobBytes) return `blobs exceed ${sandbox.maxBlobBytes} bytes`;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(job.exportFile);
  } catch {
    return "the sandbox exported no rows";
  }
  if (!stat.isFile()) return "the export is not a regular file";
  if (stat.size > sandbox.maxExportBytes) return `export exceeds ${sandbox.maxExportBytes} bytes`;
  let exported: unknown;
  try {
    exported = JSON.parse(readFileSync(job.exportFile, "utf8"));
  } catch {
    return "the export is not JSON";
  }
  const result = store.archive.importTree(rootRunId, exported);
  return result.ok ? undefined : result.error;
}

/** Deletes symlinks and other non-regular entries under `dir`, so no host read follows one out of
 * the root's directory; returns the bytes of the regular files left. */
function scrubBlobs(dir: string): number {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) bytes += scrubBlobs(path);
    else if (entry.isFile()) bytes += lstatSync(path).size;
    else unlinkSync(path);
  }
  return bytes;
}
