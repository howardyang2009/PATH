import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  type CompleteResult,
  dbFilePath,
  exportTreeFromFile,
  type Project,
  pathDir,
  type RunTreeExport,
  rootRunTreeDir,
} from "@path/engine";
import { type JsonValue, type LogEvent, LogEventSchema, type RunStatus } from "@path/schema";
import { z } from "zod";
import {
  type LiveRuns,
  ResumeNotFound,
  ResumeRefused,
  type StartedRun,
  type StartRunOptions,
} from "../live-runs.js";
import { RunEventHub, streamRun } from "../run-event-hub.js";
import type { SandboxMount, SandboxProcess, SandboxRuntime } from "./sandbox-runtime.js";
import type { VmJob, VmLine, VmOperation } from "./vm-entry.js";
import type { VmSlots } from "./vm-slots.js";

/** Per-run VM staging under a store's `.path`, which the reaper clears at boot. */
export const SANDBOX_DIR = "sandbox";

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

export const SANDBOX_LOST = "sandbox lost";

/** Whose runs these are, for the per-user run limits (docs/spec/path-website.md §8). */
export interface RunOwner {
  userId: string;
  /** The VMs this user may run at once; their other launches stay `pending`. */
  maxRunningVms: number;
  /** Why a queued launch may not start once it holds a slot, or `undefined`. */
  startRefusal?(): string | undefined;
  /** Starts the clock on one VM's time; the returned function stops it. */
  meter?(): () => void;
  /** Why this user's storage refuses a VM's import, or `undefined`. */
  importRefusal?(): string | undefined;
}

const UNLIMITED: RunOwner = { userId: "", maxRunningVms: Number.POSITIVE_INFINITY };

/** Why the host stopped a VM. */
type StopReason = "cancel" | "timeout";

/** What one VM invocation left: how the host ended rows the VM did not, and a Complete's result. */
interface Invocation {
  ended?: "cancelled" | "failed";
  error?: string;
  result?: CompleteResult;
}

/** The fields of a run option set every operation shares. */
type SharedOptions = Pick<
  StartRunOptions,
  | "files"
  | "operatorConfig"
  | "logBackends"
  | "processorConcurrency"
  | "sourceWorkflowPath"
  | "userSecrets"
>;

/**
 * `LiveRuns` for hosted mode (ADR 0091): Start, Resume and Complete each run in a fresh VM. The
 * host keeps the record: it writes a `pending` root row for a new tree at once, republishes the
 * VM's events live, replaces the tree's rows with the VM's validated export at exit, and ends what
 * a cancelled, stopped or lost VM left running.
 */
export function createSandboxedRuns(
  store: Project,
  sandbox: SandboxOptions,
  owner: RunOwner = UNLIMITED,
): LiveRuns {
  const hub = new RunEventHub();
  /** Each root a VM invocation holds, queued or running, with how to stop it. */
  const stops = new Map<string, (reason: StopReason) => void>();
  /** Each running root's events so far that the store does not hold yet. */
  const streamed = new Map<string, LogEvent[]>();
  const inFlight = new Set<Promise<unknown>>();

  function track<T>(work: Promise<T>): Promise<T> {
    inFlight.add(work);
    work.finally(() => inFlight.delete(work)).catch(() => {});
    return work;
  }

  async function invoke(job: VmJob, env: { [name: string]: string }): Promise<Invocation> {
    const rootRunId = job.rootRunId;
    let reason: StopReason | undefined;
    let vm: SandboxProcess | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (why: StopReason): void => {
      reason ??= why;
      if (vm === undefined || killTimer !== undefined) return;
      vm.terminate();
      killTimer = setTimeout(() => vm?.kill(), sandbox.stopGraceMs);
    };
    const ticket = sandbox.slots.take(owner.userId, owner.maxRunningVms);
    stops.set(rootRunId, (why) => {
      ticket.cancel();
      stop(why);
    });

    const release = await ticket.slot;
    if (release === null || reason !== undefined) {
      release?.();
      await store.archive.endNonTerminal(rootRunId, "cancelled");
      return { ended: "cancelled" };
    }
    // The limits may have run out while the launch waited.
    const refused = owner.startRefusal?.();
    if (refused !== undefined) {
      release();
      await store.archive.endNonTerminal(rootRunId, "failed", refused);
      return { ended: "failed", error: refused };
    }
    const staging = stagingDir(store, rootRunId);
    const endMeter = owner.meter?.();
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
      if (job.operation.kind !== "complete") markRoot(store, job, "running");
      const timeout = setTimeout(() => stop("timeout"), sandbox.timeoutMs);
      const code = await vm.exited;
      clearTimeout(timeout);
      clearTimeout(killTimer);

      const refusal =
        owner.importRefusal?.() ??
        (code === 0
          ? importVmExport(store, rootRunId, job.exportFile, sandbox)
          : recoverFromStaging(store, rootRunId, sandbox));
      if (refusal !== undefined) console.error(`run ${rootRunId}: ${refusal}`);
      const end: Invocation =
        reason === "cancel"
          ? { ended: "cancelled" }
          : reason === "timeout"
            ? { ended: "failed", error: "the run reached its sandbox time limit" }
            : code !== 0
              ? { ended: "failed", error: SANDBOX_LOST }
              : refusal !== undefined
                ? { ended: "failed", error: `the sandbox export was refused: ${refusal}` }
                : {};
      if (end.ended !== undefined) {
        await store.archive.endNonTerminal(rootRunId, end.ended, end.error);
      }
      const result = code === 0 && refusal === undefined ? readResult(store, job) : undefined;
      return { ...end, ...(result ? { result } : {}) };
    } finally {
      endMeter?.();
      release();
      streamed.delete(rootRunId);
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Runs a job for a new tree in the background; the tree's `pending` row is already written. */
  function launch(job: VmJob, env: { [name: string]: string }): StartedRun {
    const rootRunId = job.rootRunId;
    hub.open(rootRunId);
    track(
      invoke(job, env)
        .catch(async (err) => {
          console.error(`run ${rootRunId} crashed: ${err instanceof Error ? err.stack : err}`);
          await store.archive.endNonTerminal(rootRunId, "failed", SANDBOX_LOST);
        })
        .finally(() => {
          stops.delete(rootRunId);
          hub.close(rootRunId);
        }),
    );
    return { runId: rootRunId, rootRunId };
  }

  const vmEnv = (options: SharedOptions): { [name: string]: string } => ({
    ...sandbox.hostEnv,
    ...(options.userSecrets ?? {}),
  });

  return {
    async start(rootFile, workflowDir, options) {
      const job = vmJob(store, randomUUID(), rootFile, workflowDir, options, {
        kind: "start",
        input: options.input,
        operatorInput: options.operatorInput,
        launchWorkerDefaults: options.launchWorkerDefaults,
      });
      markRoot(store, job, "pending");
      return launch(job, vmEnv(options));
    },

    async resume(rootFile, resumeRootRunId, workflowDir, options) {
      const refusal = store.checkResume(rootFile, resumeRootRunId, workflowDir, options);
      if (refusal !== undefined) {
        throw "refusal" in refusal
          ? new ResumeRefused(refusal.refusal.status, refusal.refusal.message)
          : new ResumeNotFound(refusal.error);
      }
      const job = vmJob(store, randomUUID(), rootFile, workflowDir, options, {
        kind: "resume",
        predecessorRootRunId: resumeRootRunId,
        rerunFromRunId: options.rerunFromRunId,
      });
      job.copyIn = copyIn(store, [resumeRootRunId]);
      markRoot(store, job, "pending", resumeRootRunId);
      return launch(job, vmEnv(options));
    },

    async complete(rootFile, rootRunId, stepRunId, output, workflowDir, options) {
      const refusal = store.checkComplete(rootFile, stepRunId, output, workflowDir, options);
      if (refusal !== undefined) return refusal;
      if (stops.has(rootRunId)) {
        return {
          ok: false,
          reason: "lease-held",
          message: `run "${rootRunId}" is being completed in another invocation`,
        };
      }
      const job = vmJob(store, rootRunId, rootFile, workflowDir, options, {
        kind: "complete",
        stepRunId,
        output,
      });
      job.copyIn = copyIn(store, [rootRunId]);
      hub.open(rootRunId);
      const done = await track(
        invoke(job, vmEnv(options)).finally(() => {
          stops.delete(rootRunId);
          hub.close(rootRunId);
        }),
      );
      return (
        done.result ?? {
          ok: true,
          rootRunId,
          status: done.ended ?? "failed",
          output: null,
          ...(done.error !== undefined ? { error: done.error } : {}),
        }
      );
    },

    cancel(rootRunId) {
      const stop = stops.get(rootRunId);
      if (stop === undefined) return false;
      stop("cancel");
      return true;
    },

    stream(rootRunId, afterSeq, handlers) {
      // The store's narrative, then what the running VM streamed past it.
      const history = (after: number | undefined): LogEvent[] => {
        const stored = store.archive.tree(rootRunId)?.events(after) ?? [];
        const from = Math.max(after ?? 0, stored.at(-1)?.seq ?? 0);
        const live = streamed.get(rootRunId) ?? [];
        return [...stored, ...live.filter((event) => event.seq > from)];
      };
      return streamRun(hub, history, rootRunId, afterSeq, handlers);
    },

    get cancellable() {
      return stops.size;
    },

    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

export function stagingDir(store: Project, rootRunId: string): string {
  return join(pathDir(store.dir), SANDBOX_DIR, rootRunId);
}

/** The job a VM runs. Paths are the ones the VM sees: its own project under the staging
 * directory, the workflow directories where they sit on the host. */
function vmJob(
  store: Project,
  rootRunId: string,
  rootFile: VmJob["rootFile"],
  workflowDir: string,
  options: SharedOptions,
  operation: VmOperation,
): VmJob {
  const staging = stagingDir(store, rootRunId);
  return {
    operation,
    rootRunId,
    projectDir: join(staging, "project"),
    workflowDir,
    rootFile,
    files: [...options.files],
    copyIn: [],
    exportFile: join(staging, "io", "export.json"),
    resultFile: join(staging, "io", "result.json"),
    secretNames: Object.keys(options.userSecrets ?? {}),
    operatorConfig: options.operatorConfig,
    logBackends: options.logBackends,
    processorConcurrency: options.processorConcurrency,
    sourceWorkflowPath: options.sourceWorkflowPath,
  };
}

/** The trees a continuation of `roots` reads: those trees, and each tree a reuse row of theirs
 * reuses from. */
function copyIn(store: Project, roots: string[]): VmJob["copyIn"] {
  const trees: VmJob["copyIn"] = [];
  const pending = [...roots];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const rootRunId = pending.shift() as string;
    if (seen.has(rootRunId)) continue;
    seen.add(rootRunId);
    const tree = store.archive.exportTree(rootRunId);
    if (tree === null) continue;
    trees.push({ rootRunId, tree });
    if (!roots.includes(rootRunId)) continue;
    for (const row of tree.runs) {
      const source = row.reused_from_run_id;
      const sourceRoot = typeof source === "string" ? store.archive.rootRunIdOf(source) : null;
      if (sourceRoot !== null) pending.push(sourceRoot);
    }
  }
  return trees;
}

/**
 * Writes the job file and returns what the VM mounts: the job directory and the VM's project
 * read-write, the written tree's blobs read-write inside it, every copied-in tree's blobs and
 * every workflow file's directory read-only.
 */
function prepareMounts(store: Project, job: VmJob, staging: string): SandboxMount[] {
  const io = join(staging, "io");
  mkdirSync(io, { recursive: true });
  mkdirSync(job.projectDir, { recursive: true });
  writeFileSync(join(io, "job.json"), JSON.stringify(job));
  const blobs = (rootRunId: string, readOnly: boolean): SandboxMount => ({
    hostPath: rootRunTreeDir(store.dir, rootRunId),
    guestPath: rootRunTreeDir(job.projectDir, rootRunId),
    readOnly,
  });
  mkdirSync(rootRunTreeDir(store.dir, job.rootRunId), { recursive: true });

  const dirs = [job.workflowDir, ...job.files.map(([path]) => dirname(path))].sort();
  const workflowDirs = dirs.filter(
    (dir, i) => !dirs.slice(0, i).some((outer) => dir === outer || dir.startsWith(outer + sep)),
  );
  return [
    { hostPath: io, guestPath: io, readOnly: false },
    { hostPath: job.projectDir, guestPath: job.projectDir, readOnly: false },
    blobs(job.rootRunId, false),
    ...job.copyIn
      .filter(({ rootRunId }) => rootRunId !== job.rootRunId)
      .filter(({ rootRunId }) => existsSync(rootRunTreeDir(store.dir, rootRunId)))
      .map(({ rootRunId }) => blobs(rootRunId, true)),
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

/** The host's own root row for a new tree, used until the VM's export replaces it. */
function markRoot(store: Project, job: VmJob, status: RunStatus, resumedFrom?: string): void {
  const rootRunId = job.rootRunId;
  // The staging directory marks the tree as the sandbox's, so a reaper finds a queued run too.
  mkdirSync(stagingDir(store, rootRunId), { recursive: true });
  const now = new Date().toISOString();
  const result = store.archive.importTree(rootRunId, {
    runs: [
      {
        run_id: rootRunId,
        root_run_id: rootRunId,
        parent_run_id: null,
        status,
        started_at: store.archive.tree(rootRunId)?.root?.startedAt ?? now,
        resumed_from_root_run_id:
          resumedFrom ?? store.archive.tree(rootRunId)?.root?.resumedFromRootRunId ?? null,
        workflow_id: job.rootFile.id ?? null,
        workflow_name: job.rootFile.name ?? null,
        workflow_path: job.sourceWorkflowPath ?? null,
      },
    ],
    events: [],
  } satisfies RunTreeExport);
  if (!result.ok) console.error(`run ${rootRunId}: ${result.error}`);
}

/**
 * A Complete's result as the VM wrote it, checked against the rows the host imported: the status
 * comes from the stored root, never the VM's word. `undefined` for any other operation or a
 * missing or malformed file.
 */
function readResult(store: Project, job: VmJob): CompleteResult | undefined {
  if (job.operation.kind !== "complete") return undefined;
  let parsed: unknown;
  try {
    if (!lstatSync(job.resultFile).isFile()) return undefined;
    parsed = JSON.parse(readFileSync(job.resultFile, "utf8"));
  } catch {
    return undefined;
  }
  const result = CompleteResultSchema.safeParse(parsed);
  if (!result.success) return undefined;
  if (!result.data.ok) return result.data as CompleteResult;
  const root = store.archive.tree(job.rootRunId)?.root;
  if (!root) return undefined;
  const status = store.archive.displayStatus(root);
  if (status === "pending" || status === "running") return undefined;
  const { output, error } = result.data;
  return {
    ok: true,
    rootRunId: job.rootRunId,
    status,
    output: (output ?? null) as JsonValue,
    ...(error !== undefined ? { error } : {}),
  };
}

const CompleteResultSchema = z.union([
  z.object({
    ok: z.literal(false),
    reason: z.enum(["not-found", "not-awaiting", "lease-held", "node-gone", "output-invalid"]),
    message: z.string(),
    details: z.array(z.unknown()).optional(),
  }),
  z.object({ ok: z.literal(true), output: z.unknown(), error: z.string().optional() }),
]);

/** Imports the VM's export after removing every non-regular file it left in the blob directory.
 * Returns why the import was refused, or `undefined` once it landed. */
function importVmExport(
  store: Project,
  rootRunId: string,
  exportFile: string,
  sandbox: Pick<SandboxOptions, "maxExportBytes" | "maxBlobBytes">,
): string | undefined {
  const blobBytes = scrubBlobs(rootRunTreeDir(store.dir, rootRunId));
  if (blobBytes > sandbox.maxBlobBytes) return `blobs exceed ${sandbox.maxBlobBytes} bytes`;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(exportFile);
  } catch {
    return "the sandbox exported no rows";
  }
  if (!stat.isFile()) return "the export is not a regular file";
  if (stat.size > sandbox.maxExportBytes) return `export exceeds ${sandbox.maxExportBytes} bytes`;
  let exported: unknown;
  try {
    exported = JSON.parse(readFileSync(exportFile, "utf8"));
  } catch {
    return "the export is not JSON";
  }
  const result = store.archive.importTree(rootRunId, exported);
  return result.ok ? undefined : result.error;
}

/**
 * Imports what a VM that left no export still has: its own store sits on a host mount, so the rows
 * it wrote before it died are read from there, under the same checks as an export. Returns why
 * nothing was imported, or `undefined`.
 */
export function recoverFromStaging(
  store: Project,
  rootRunId: string,
  sandbox: Pick<SandboxOptions, "maxExportBytes" | "maxBlobBytes">,
): string | undefined {
  const dbFile = dbFilePath(join(stagingDir(store, rootRunId), "project"));
  // The VM wrote these files: only plain files, within the export cap, are read at all.
  let bytes = 0;
  for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-journal`]) {
    if (!existsSync(file)) continue;
    const stat = lstatSync(file);
    if (!stat.isFile()) return `${file} is not a regular file`;
    bytes += stat.size;
  }
  if (bytes === 0) return "the sandbox left no store";
  if (bytes > sandbox.maxExportBytes)
    return `the sandbox store exceeds ${sandbox.maxExportBytes} bytes`;
  let exported: RunTreeExport | null;
  try {
    exported = exportTreeFromFile(dbFile, rootRunId);
  } catch (err) {
    return `the sandbox store is unreadable: ${err instanceof Error ? err.message : err}`;
  }
  if (exported === null) return "the sandbox store holds no rows for the run";
  const exportFile = join(stagingDir(store, rootRunId), "io", "recovered.json");
  mkdirSync(dirname(exportFile), { recursive: true });
  writeFileSync(exportFile, JSON.stringify(exported));
  return importVmExport(store, rootRunId, exportFile, sandbox);
}

/** Deletes symlinks and other non-regular entries under `dir`, so no host read follows one out of
 * the root's directory; returns the bytes of the regular files left. */
function scrubBlobs(dir: string): number {
  if (!existsSync(dir)) return 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) bytes += scrubBlobs(path);
    else if (entry.isFile()) bytes += lstatSync(path).size;
    else unlinkSync(path);
  }
  return bytes;
}
