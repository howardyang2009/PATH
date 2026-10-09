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
import { type LiveRuns, ResumeNotFound, type StartRunOptions } from "../src/live-runs.js";
import {
  createSandboxedRuns,
  type RunOwner,
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

function sandboxed(
  behaviour: FakeBehaviour,
  overrides: Partial<SandboxOptions> = {},
  owner?: RunOwner,
) {
  const runtime = fakeRuntime(behaviour);
  const runs = createSandboxedRuns(
    store,
    {
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
    },
    owner,
  );
  return { runtime, runs };
}

/** Writes a workflow at a fixed name (so a later write replaces it) and loads it. */
async function writeWorkflow(
  name: string,
  body: object[],
): Promise<[WorkflowFile, string, StartRunOptions]> {
  const path = join(dir, "users", "alice", "workflow", `${name}.workflow.json`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ format: "path/workflow@6", id: idFor("workflow"), name, body }),
  );
  const loaded = await loadWorkflowTree(path);
  if (!loaded.success) throw new Error(loaded.errors.join("\n"));
  const { rootFile, workflowDir, files, registry } = loaded.workflow;
  return [rootFile, workflowDir, { files, registry, sourceWorkflowPath: `workflow/${name}` }];
}

/** A stable UUIDv4 per name, so a rewritten workflow keeps its node ids. */
const ids = new Map<string, string>();
function idFor(name: string): string {
  if (!ids.has(name)) ids.set(name, randomUUID());
  return ids.get(name) as string;
}

const step = (name: string, script: string) => ({
  type: "binary",
  id: idFor(name),
  name,
  command: "node",
  args: ["-e", script],
});
const park = {
  type: "person-activity",
  id: idFor("approve"),
  name: "approve",
  description: "approve",
};

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

  it("records the launch's secret config paths on the pending root, before any export", async () => {
    const { runs } = sandboxed(inProcessVm, { slots: createVmSlots(0) });
    const [rootFile, workflowDir, options] = await workflow("");
    const started = await runs.start(rootFile, workflowDir, {
      ...options,
      operatorConfig: { CLAUDE_CODE_OAUTH_TOKEN: { $secret: "sk-ant-oat01-x" }, model: "m" },
    });

    expect(store.archive.launchFacts(started.rootRunId)).toEqual({
      secretKeys: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });
    runs.cancel(started.rootRunId);
    await settled(runs, started.rootRunId);
  });

  it("mounts only the job, the VM's store, the root's blobs and the workflow directory", async () => {
    const { runtime, runs } = sandboxed(inProcessVm);
    const [file, workflowDir, options] = await workflow("process.stdout.write('hi')");
    const started = await runs.start(file, workflowDir, options);
    await settled(runs, started.rootRunId);

    const mounts = runtime.vms[0]?.spec.mounts ?? [];
    expect(mounts.map((m) => [m.hostPath, m.readOnly])).toEqual([
      [join(store.dir, ".path", "sandbox", started.rootRunId, "io"), false],
      [join(store.dir, ".path", "sandbox", started.rootRunId, "project"), false],
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
      const blobs = vm.spec.mounts[2]?.hostPath ?? "";
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

describe("the run limits", () => {
  it("keeps a user's second launch pending while their first runs", async () => {
    const exits: ((code: number) => void)[] = [];
    const { runtime, runs } = sandboxed(
      () => new Promise((r) => exits.push(r)),
      {},
      {
        userId: "alice",
        maxRunningVms: 1,
      },
    );
    const first = await runs.start(...(await workflow("")));
    const second = await runs.start(...(await workflow("")));

    await launchedVms(runtime.vms, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(runtime.vms).toHaveLength(1);
    expect(store.archive.tree(second.rootRunId)?.root?.status).toBe("pending");
    exits[0]?.(1);
    await launchedVms(runtime.vms, 2);
    expect(runtime.vms[1]?.spec.labels["path.root-run-id"]).toBe(second.rootRunId);
    exits[1]?.(1);
    await settled(runs, first.rootRunId);
  });

  it("meters each VM's time from launch to exit", async () => {
    const meter: string[] = [];
    const { runs } = sandboxed(
      inProcessVm,
      {},
      {
        userId: "alice",
        maxRunningVms: 1,
        meter: () => {
          meter.push("begin");
          return () => meter.push("end");
        },
      },
    );
    const started = await runs.start(...(await workflow("process.stdout.write('b')")));

    expect(await settled(runs, started.rootRunId)).toBe("succeeded");
    expect(meter).toEqual(["begin", "end"]);
  });

  it("fails a queued launch whose limits ran out while it waited", async () => {
    let limitHit: string | undefined;
    const { runtime, runs } = sandboxed(
      inProcessVm,
      {},
      {
        userId: "alice",
        maxRunningVms: 1,
        startRefusal: () => limitHit,
      },
    );
    limitHit = "budget used";
    const started = await runs.start(...(await workflow("process.stdout.write('b')")));

    expect(await settled(runs, started.rootRunId)).toBe("failed");
    expect(runtime.vms).toHaveLength(0);
    const end = store.archive.tree(started.rootRunId)?.events().at(-1);
    expect(end).toMatchObject({ error: "budget used" });
  });

  it("refuses the import when the user's storage is full", async () => {
    const { runs } = sandboxed(
      inProcessVm,
      {},
      {
        userId: "alice",
        maxRunningVms: 1,
        importRefusal: () => "storage full, delete runs",
      },
    );
    const started = await runs.start(...(await workflow("process.stdout.write('b')")));

    expect(await settled(runs, started.rootRunId)).toBe("failed");
    const end = store.archive.tree(started.rootRunId)?.events().at(-1);
    expect(end).toMatchObject({ error: expect.stringMatching(/storage full, delete runs/) });
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

describe("a sandboxed Complete", () => {
  it("drives the awaiting leaf in a fresh VM, continuing the tree's narrative", async () => {
    const { runtime, runs } = sandboxed(inProcessVm);
    const wf = await writeWorkflow("parked", [
      step("a", "process.stdout.write('A')"),
      park,
      step("b", ""),
    ]);
    const { rootRunId } = await runs.start(...wf);
    expect(await settled(runs, rootRunId)).toBe("running");
    const leaf = store.archive.tree(rootRunId)?.runs.find((r) => r.status === "awaiting");
    const before = store.archive.tree(rootRunId)?.events().length ?? 0;

    const [file, workflowDir, options] = wf;
    const result = await runs.complete(
      file,
      rootRunId,
      leaf?.runId ?? "",
      {},
      workflowDir,
      options,
    );

    expect(result).toMatchObject({ ok: true, rootRunId, status: "succeeded" });
    expect(runtime.vms.map((vm) => vm.job().operation.kind)).toEqual(["start", "complete"]);
    const tree = store.archive.tree(rootRunId);
    expect(tree?.root?.status).toBe("succeeded");
    const seqs = tree?.events().map((e) => e.seq) ?? [];
    expect(seqs.length).toBeGreaterThan(before);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("answers a refusal without a VM", async () => {
    const { runtime, runs } = sandboxed(inProcessVm);
    const [file, workflowDir, options] = await writeWorkflow("parked", [park]);
    const { rootRunId } = await runs.start(file, workflowDir, options);
    await settled(runs, rootRunId);

    const result = await runs.complete(file, rootRunId, "nope", {}, workflowDir, options);
    expect(result).toMatchObject({ ok: false, reason: "not-found" });
    expect(runtime.vms).toHaveLength(1);
  });
});

describe("a sandboxed Resume", () => {
  it("runs the successor in a fresh VM over the predecessor's rows and read-only blobs", async () => {
    const { runtime, runs } = sandboxed(inProcessVm);
    const v1 = await writeWorkflow("flaky", [
      step("a", "process.stdout.write('A')"),
      step("b", "process.exit(1)"),
    ]);
    const first = await runs.start(...v1);
    expect(await settled(runs, first.rootRunId)).toBe("failed");

    const [file, workflowDir, options] = await writeWorkflow("flaky", [
      step("a", "process.stdout.write('A')"),
      step("b", "process.stdout.write('B')"),
    ]);
    const successor = await runs.resume(file, first.rootRunId, workflowDir, options);

    expect(successor.rootRunId).not.toBe(first.rootRunId);
    expect(await settled(runs, successor.rootRunId)).toBe("succeeded");
    const vm = runtime.vms[1];
    expect(vm?.job().operation).toMatchObject({
      kind: "resume",
      predecessorRootRunId: first.rootRunId,
    });
    expect(vm?.spec.mounts).toContainEqual(
      expect.objectContaining({
        hostPath: rootRunTreeDir(store.dir, first.rootRunId),
        readOnly: true,
      }),
    );
    const tree = store.archive.tree(successor.rootRunId);
    expect(tree?.root?.resumedFromRootRunId).toBe(first.rootRunId);
    expect(tree?.runs.some((r) => r.reusedFromRunId !== null)).toBe(true);
  });

  it("refuses an unknown predecessor without a VM", async () => {
    const { runtime, runs } = sandboxed(inProcessVm);
    const [file, workflowDir, options] = await writeWorkflow("flaky", [step("a", "")]);
    await expect(runs.resume(file, "nope", workflowDir, options)).rejects.toBeInstanceOf(
      ResumeNotFound,
    );
    expect(runtime.vms).toHaveLength(0);
  });
});

describe("a sandboxed Cancel", () => {
  it("stops the engine, which exports the run cancelled", async () => {
    const { runtime, runs } = sandboxed(inProcessVm);
    const { rootRunId } = await runs.start(...(await workflow("setTimeout(() => {}, 60000)")));
    await launchedVms(runtime.vms, 1);
    await new Promise((r) => setTimeout(r, 200));

    expect(runs.cancel(rootRunId)).toBe(true);
    expect(await settled(runs, rootRunId)).toBe("cancelled");
    expect(store.archive.tree(rootRunId)?.runs.every((r) => r.status === "cancelled")).toBe(true);
  });

  it("kills a VM that ignores the stop and marks its rows cancelled", async () => {
    const { runtime, runs } = sandboxed(() => new Promise(() => {}));
    const { rootRunId } = await runs.start(...(await workflow("")));
    await launchedVms(runtime.vms, 1);

    runs.cancel(rootRunId);
    expect(await settled(runs, rootRunId)).toBe("cancelled");
    expect(runtime.vms[0]?.killed).toBe(true);
  });
});

describe("a lost VM", () => {
  /** The real entry parks the run, then the VM dies before its export reaches the host. */
  const lost: FakeBehaviour = async (vm) => {
    await inProcessVm(vm);
    rmSync(vm.job().exportFile);
    return null;
  };

  it("keeps the rows its store holds, ends the live ones failed, and stays resumable", async () => {
    const { runs } = sandboxed(lost);
    const wf = await writeWorkflow("parked", [step("a", "process.stdout.write('A')"), park]);
    const { rootRunId } = await runs.start(...wf);

    expect(await settled(runs, rootRunId)).toBe("failed");
    const tree = store.archive.tree(rootRunId);
    expect(tree?.runs.find((r) => r.nodeName === "a")?.status).toBe("succeeded");
    expect(tree?.runs.find((r) => r.nodeName === "approve")?.status).toBe("failed");
    expect(tree?.events().at(-1)).toMatchObject({ type: "step-finished", error: "sandbox lost" });

    const healthy = sandboxed(inProcessVm);
    const successor = await healthy.runs.resume(wf[0], rootRunId, wf[1], wf[2]);
    await healthy.runs.idle();
    const parked = store.archive.tree(successor.rootRunId)?.runs;
    expect(parked?.some((r) => r.status === "awaiting")).toBe(true);
  });
});
