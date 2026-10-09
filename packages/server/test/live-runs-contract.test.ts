import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type LoadedWorkflow, loadWorkflowTree, openProject, type Project } from "@path/engine";
import type { LogEvent, RunStatus } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveRuns, type LiveRuns, ResumeNotFound } from "../src/live-runs.js";
import { createSandboxedRuns, SANDBOX_LIMITS } from "../src/sandbox/sandboxed-runs.js";
import { createVmSlots } from "../src/sandbox/vm-slots.js";
import { fakeRuntime, inProcessVm } from "./fixtures/fake-sandbox.js";

/**
 * The `LiveRuns` contract both executors keep: in process, and a VM per invocation with the VM
 * faked behind the `SandboxRuntime` seam. One suite, so the two cannot drift apart.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

const ADAPTERS: [string, (store: Project) => LiveRuns][] = [
  ["in process", (store) => createLiveRuns(store)],
  [
    "in a VM",
    (store) =>
      createSandboxedRuns(store, {
        runtime: fakeRuntime(inProcessVm),
        slots: createVmSlots(SANDBOX_LIMITS.maxVms),
        image: "path-run:test",
        cpus: SANDBOX_LIMITS.cpus,
        memoryMiB: SANDBOX_LIMITS.memoryMiB,
        timeoutMs: SANDBOX_LIMITS.timeoutMs,
        stopGraceMs: 50,
        maxExportBytes: SANDBOX_LIMITS.maxExportBytes,
        maxBlobBytes: SANDBOX_LIMITS.maxBlobBytes,
        hostEnv: {},
      }),
  ],
];

let dir: string;
let store: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-live-runs-contract-"));
  const opened = openProject(dir);
  if (!opened.success) throw new Error(opened.error);
  store = opened.project;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function load(name: string): Promise<LoadedWorkflow> {
  const loaded = await loadWorkflowTree(join(FIXTURES, name));
  if (!loaded.success) throw new Error(loaded.errors.join("\n"));
  return loaded.workflow;
}

const options = (workflow: LoadedWorkflow) => ({
  files: workflow.files,
  registry: workflow.registry,
  sourceWorkflowPath: workflow.storeRelativePath(dir),
});

function statusOf(rootRunId: string): RunStatus | undefined {
  const root = store.archive.tree(rootRunId)?.root;
  return root ? store.archive.displayStatus(root) : undefined;
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(done()).toBe(true);
}

describe.each(ADAPTERS)("LiveRuns %s", (_name, liveRunsOf) => {
  it("starts a run, streams its narrative to the end, and drains", async () => {
    const live = liveRunsOf(store);
    const workflow = await load("two-binary-steps.workflow.json");
    const ids = await live.start(workflow.rootFile, workflow.workflowDir, options(workflow));
    expect(ids.runId).toBe(ids.rootRunId);

    const events: LogEvent[] = [];
    const ended = new Promise<void>((resolve) => {
      live.stream(ids.rootRunId, undefined, { onEvent: (e) => events.push(e), onEnd: resolve });
    });
    await ended;
    await live.idle();

    expect(statusOf(ids.rootRunId)).toBe("succeeded");
    expect(live.cancellable).toBe(0);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs.length).toBeGreaterThan(0);
  });

  it("cancels a running root once, and answers false for a root it does not drive", async () => {
    const live = liveRunsOf(store);
    expect(live.cancel("no-such-root")).toBe(false);
    const workflow = await load("long-step.workflow.json");
    const ids = await live.start(workflow.rootFile, workflow.workflowDir, options(workflow));
    await until(() => statusOf(ids.rootRunId) === "running");

    expect(live.cancellable).toBe(1);
    expect(live.cancel(ids.rootRunId)).toBe(true);
    await live.idle();

    expect(statusOf(ids.rootRunId)).toBe("cancelled");
    expect(live.cancel(ids.rootRunId)).toBe(false);
  });

  it("rejects a Resume of an unknown root before any successor exists", async () => {
    const live = liveRunsOf(store);
    const workflow = await load("failing-step.workflow.json");
    await expect(
      live.resume(workflow.rootFile, "no-such-root", workflow.workflowDir, options(workflow)),
    ).rejects.toBeInstanceOf(ResumeNotFound);
    await live.idle();
    expect(live.cancellable).toBe(0);
  });

  it("completes a parked leaf and drives the tree to its end", async () => {
    const live = liveRunsOf(store);
    const workflow = await load("awaiting-no-schema.workflow.json");
    const ids = await live.start(workflow.rootFile, workflow.workflowDir, options(workflow));
    await until(() => statusOf(ids.rootRunId) === "awaiting");
    await live.idle();
    const leaf = store.archive.tree(ids.rootRunId)?.runs.find((r) => r.status === "awaiting");

    const result = await live.complete(
      workflow.rootFile,
      ids.rootRunId,
      leaf?.runId ?? "",
      "done",
      workflow.workflowDir,
      options(workflow),
    );

    expect(result).toMatchObject({ ok: true, rootRunId: ids.rootRunId, status: "succeeded" });
    expect(statusOf(ids.rootRunId)).toBe("succeeded");
    expect(live.cancellable).toBe(0);
  });
});
