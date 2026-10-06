import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowTree, openProject, type Project, rootRunTreeDir } from "@path/engine";
import type { LogEvent, WorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveRuns, StartRunOptions } from "../src/live-runs.js";
import {
  createSandboxedRuns,
  SANDBOX_LIMITS,
  type SandboxOptions,
} from "../src/sandbox/sandboxed-runs.js";
import { createVmSlots } from "../src/sandbox/vm-slots.js";
import {
  type FakeBehaviour,
  type FakeVm,
  fakeRuntime,
  inProcessVm,
} from "./fixtures/fake-sandbox.js";

/**
 * Hosted Start through `SandboxedRuns` (ADR 0091), with the VM faked behind the `SandboxRuntime`
 * seam: the host writes a `pending` root at once, republishes the VM's events live, imports only a
 * validated export, gives the VM nothing but the launcher's secrets and the host allowlist, queues
 * launches past the VM cap, and stops a VM at its time limit.
 */

let dir: string;
let store: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-server-sandboxed-runs-test-"));
  const opened = openProject(join(dir, "users", "alice"));
  if (!opened.success) throw new Error(opened.error);
  store = opened.project;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function sandboxed(behaviour: FakeBehaviour, overrides: Partial<SandboxOptions> = {}) {
  const runtime = fakeRuntime(behaviour);
  const runs = createSandboxedRuns(store, {
    runtime,
    slots: createVmSlots(SANDBOX_LIMITS.maxVms),
    image: "path-run:test",
    cpus: SANDBOX_LIMITS.cpus,
    memoryMiB: SANDBOX_LIMITS.memoryMiB,
    timeoutMs: SANDBOX_LIMITS.timeoutMs,
    stopGraceMs: 50,
    maxExportBytes: SANDBOX_LIMITS.maxExportBytes,
    maxBlobBytes: SANDBOX_LIMITS.maxBlobBytes,
    hostEnv: { DEEPSEEK_BASE_URL: "https://gateway.example" },
    ...overrides,
  });
  return { runtime, runs };
}

/** A one-step workflow whose output is what its binary step prints for `script`. */
async function workflow(
  script: string,
  config?: object,
): Promise<[WorkflowFile, string, StartRunOptions]> {
  const path = join(dir, "users", "alice", "workflow", `${randomUUID()}.workflow.json`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      format: "path/workflow@6",
      id: randomUUID(),
      name: "echo",
      ...(config ? { config } : {}),
      body: [
        {
          type: "binary",
          id: randomUUID(),
          name: "echo",
          command: "node",
          args: ["-e", script, ...(config ? ["${config.token}"] : [])],
          publish: { seen: "${output}" },
        },
      ],
      output: { seen: "${context.seen}" },
    }),
  );
  const loaded = await loadWorkflowTree(path);
  if (!loaded.success) throw new Error(loaded.errors.join("\n"));
  const { rootFile, workflowDir, files, registry } = loaded.workflow;
  return [rootFile, workflowDir, { files, registry, sourceWorkflowPath: "workflow/echo" }];
}

async function settled(runs: LiveRuns, rootRunId: string): Promise<string | undefined> {
  await runs.idle();
  return store.archive.tree(rootRunId)?.root?.status;
}

/** Resolves once `n` VMs have started. */
async function launchedVms(vms: FakeVm[], n: number): Promise<void> {
  while (vms.length < n) await new Promise((r) => setTimeout(r, 5));
}

describe("a sandboxed Start", () => {
  it("runs the whole root run in one VM and streams its events live", async () => {
    const { runtime, runs } = sandboxed(inProcessVm);
    const started = await runs.start(...(await workflow("process.stdout.write('hi')")));

    const live: LogEvent[] = [];
    let ended = false;
    runs.stream(started.rootRunId, undefined, {
      onEvent: (event) => live.push(event),
      onEnd: () => {
        ended = true;
      },
    });

    expect(await settled(runs, started.rootRunId)).toBe("succeeded");
    expect(runtime.vms).toHaveLength(1);
    expect(ended).toBe(true);
    expect(live.map((e) => e.type)).toContain("step-finished");
    const tree = store.archive.tree(started.rootRunId);
    expect(tree?.runs.length).toBeGreaterThan(1);
    expect(tree?.output()).toEqual({ seen: "hi" });
    expect(tree?.events().length).toBe(live.length);
  });

  it("replays the events so far to a Viewer that joins mid-run", async () => {
    let exit: (code: number) => void = () => {};
    const { runtime, runs } = sandboxed(
      (vm) =>
        new Promise((resolve) => {
          const event = (seq: number): string =>
            JSON.stringify({
              event: {
                type: "step-started",
                seq,
                ts: new Date().toISOString(),
                run_id: vm.job().rootRunId,
                node_id: "echo",
                node_name: "echo",
                step_type: "binary",
                worker_name: "spawn",
              },
            });
          vm.emit(event(1));
          vm.emit(event(1));
          vm.emit(event(2));
          exit = resolve;
        }),
    );
    const started = await runs.start(...(await workflow("")));
    await launchedVms(runtime.vms, 1);

    const seen: number[] = [];
    runs.stream(started.rootRunId, 1, { onEvent: (e) => seen.push(e.seq), onEnd: () => {} });
    expect(seen).toEqual([2]);
    expect(store.archive.tree(started.rootRunId)?.root?.status).toBe("running");
    exit(1);
    await runs.idle();
  });

  it("answers at once with a pending root", async () => {
    const { runs } = sandboxed(inProcessVm, { slots: createVmSlots(0) });
    const started = await runs.start(...(await workflow("")));

    expect(started.runId).toBe(started.rootRunId);
    const root = store.archive.tree(started.rootRunId)?.root;
    expect(root?.status).toBe("pending");
    expect(root?.workflowName).toBe("echo");
    runs.cancel(started.rootRunId);
    expect(await settled(runs, started.rootRunId)).toBe("cancelled");
  });

  it("mounts only the job, the root's blobs and the workflow directory", async () => {
    const { runtime, runs } = sandboxed(inProcessVm);
    const [file, workflowDir, options] = await workflow("process.stdout.write('hi')");
    const started = await runs.start(file, workflowDir, options);
    await settled(runs, started.rootRunId);

    const mounts = runtime.vms[0]?.spec.mounts ?? [];
    expect(mounts.map((m) => [m.hostPath, m.readOnly])).toEqual([
      [join(store.dir, ".path", "sandbox", started.rootRunId, "io"), false],
      [rootRunTreeDir(store.dir, started.rootRunId), false],
      [workflowDir, true],
    ]);
    expect(runtime.vms[0]?.spec).toMatchObject({ cpus: 4, memoryMiB: 4096 });
  });
});

describe("the VM environment", () => {
  it("holds the launcher's secrets and the host allowlist, nothing else", async () => {
    process.env.HOST_ONLY_SECRET = "owner's own";
    try {
      const { runtime, runs } = sandboxed(inProcessVm);
      const [file, workflowDir, options] = await workflow(
        "process.stdout.write(process.argv[1].split('').reverse().join(''))",
        { token: { $env: "API_TOKEN" } },
      );
      const started = await runs.start(file, workflowDir, {
        ...options,
        userSecrets: { API_TOKEN: "sk-alice" },
      });

      expect(await settled(runs, started.rootRunId)).toBe("succeeded");
      expect(runtime.vms[0]?.spec.env).toEqual({
        DEEPSEEK_BASE_URL: "https://gateway.example",
        API_TOKEN: "sk-alice",
      });
      expect(runtime.vms[0]?.job().secretNames).toEqual(["API_TOKEN"]);
      expect(JSON.stringify(runtime.vms[0]?.job())).not.toContain("sk-alice");
      expect(store.archive.tree(started.rootRunId)?.output()).toEqual({ seen: "ecila-ks" });
    } finally {
      delete process.env.HOST_ONLY_SECRET;
    }
  });
});

describe("the VM's export", () => {
  /** Runs the real entry, then rewrites its export with `forge`. */
  const forging =
    (forge: (exported: { runs: Record<string, unknown>[] }) => void): FakeBehaviour =>
    async (vm) => {
      await inProcessVm(vm);
      const { exportFile } = vm.job();
      const exported = JSON.parse(readFileSync(exportFile, "utf8"));
      forge(exported);
      writeFileSync(exportFile, JSON.stringify(exported));
      return 0;
    };

  it("is refused with a run id from another tree", async () => {
    const victim = sandboxed(inProcessVm);
    const other = await victim.runs.start(...(await workflow("process.stdout.write('a')")));
    await settled(victim.runs, other.rootRunId);

    const { runs } = sandboxed(
      forging((exported) => {
        exported.runs.push({ ...exported.runs[0], run_id: other.rootRunId, parent_run_id: "x" });
      }),
    );
    const started = await runs.start(...(await workflow("process.stdout.write('b')")));

    expect(await settled(runs, started.rootRunId)).toBe("failed");
    expect(store.archive.tree(started.rootRunId)?.runs).toHaveLength(1);
    expect(store.archive.tree(other.rootRunId)?.output()).toEqual({ seen: "a" });
  });

  it("is refused with a blob ref outside the root's directory", async () => {
    const { runs } = sandboxed(
      forging((exported) => {
        exported.runs[0] = { ...exported.runs[0], output_ref: "runs/other/x/output.json" };
      }),
    );
    const started = await runs.start(...(await workflow("process.stdout.write('b')")));

    expect(await settled(runs, started.rootRunId)).toBe("failed");
    expect(store.archive.tree(started.rootRunId)?.output()).toBeUndefined();
  });

  it("forces every row onto the root", async () => {
    const { runs } = sandboxed(
      forging((exported) => {
        for (const row of exported.runs) row.root_run_id = "forged";
      }),
    );
    const started = await runs.start(...(await workflow("process.stdout.write('b')")));

    expect(await settled(runs, started.rootRunId)).toBe("succeeded");
    expect(store.archive.tree("forged")).toBeNull();
  });

  it("is refused past the export size cap", async () => {
    const { runs } = sandboxed(inProcessVm, { maxExportBytes: 10 });
    const started = await runs.start(...(await workflow("process.stdout.write('b')")));
    expect(await settled(runs, started.rootRunId)).toBe("failed");
  });

  it("loses every symlink the VM left in the blob directory", async () => {
    const { runs } = sandboxed(async (vm) => {
      await inProcessVm(vm);
      const blobs = vm.spec.mounts[1]?.hostPath ?? "";
      symlinkSync("/etc/hosts", join(blobs, vm.job().rootRunId, "output.json.link"));
      return 0;
    });
    const started = await runs.start(...(await workflow("process.stdout.write('b')")));

    expect(await settled(runs, started.rootRunId)).toBe("succeeded");
    expect(
      readdirSync(rootRunTreeDir(store.dir, started.rootRunId), { recursive: true }),
    ).not.toContain(join(started.rootRunId, "output.json.link"));
  });
});

describe("the VM cap", () => {
  it("keeps a fourth concurrent launch pending until a slot frees", async () => {
    const exits: ((code: number) => void)[] = [];
    const { runtime, runs } = sandboxed(() => new Promise((r) => exits.push(r)));
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await runs.start(...(await workflow("")))).rootRunId);

    await launchedVms(runtime.vms, 3);
    await new Promise((r) => setTimeout(r, 20));
    expect(runtime.vms).toHaveLength(3);
    expect(store.archive.tree(ids[3] ?? "")?.root?.status).toBe("pending");

    exits[0]?.(1);
    await launchedVms(runtime.vms, 4);
    expect(runtime.vms[3]?.spec.labels["path.root-run-id"]).toBe(ids[3]);
    for (const exit of exits.slice(1)) exit(1);
    await runs.idle();
  });

  it("cancels a queued launch without starting a VM", async () => {
    const exits: ((code: number) => void)[] = [];
    const { runtime, runs } = sandboxed(() => new Promise((r) => exits.push(r)));
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await runs.start(...(await workflow("")))).rootRunId);
    await launchedVms(runtime.vms, 3);

    expect(runs.cancel(ids[3] ?? "")).toBe(true);
    for (const exit of exits) exit(1);
    expect(await settled(runs, ids[3] ?? "")).toBe("cancelled");
    expect(runtime.vms).toHaveLength(3);
  });
});

describe("the time limit", () => {
  it("asks the engine to stop, which still exports a cancelled run", async () => {
    const { runs } = sandboxed(inProcessVm, { timeoutMs: 100 });
    const started = await runs.start(...(await workflow("setTimeout(() => {}, 60000)")));
    expect(await settled(runs, started.rootRunId)).toBe("cancelled");
  });

  it("kills a VM that ignores the stop", async () => {
    const { runtime, runs } = sandboxed(() => new Promise(() => {}), { timeoutMs: 50 });
    const started = await runs.start(...(await workflow("")));
    expect(await settled(runs, started.rootRunId)).toBe("failed");
    expect(runtime.vms[0]?.killed).toBe(true);
  });
});
