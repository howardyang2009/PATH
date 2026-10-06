import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowTree, openProject, type Project } from "@path/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reapSandboxes } from "../src/sandbox/reaper.js";
import { createSandboxedRuns, SANDBOX_LIMITS, stagingDir } from "../src/sandbox/sandboxed-runs.js";
import { createVmSlots } from "../src/sandbox/vm-slots.js";
import { type FakeVm, fakeRuntime, inProcessVm } from "./fixtures/fake-sandbox.js";

/** A Server that stopped while a VM ran leaves the VM and its staging behind; the next boot
 * removes the VM and imports what its store kept. */

let dir: string;
let store: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-server-reaper-test-"));
  const opened = openProject(join(dir, "users", "alice"));
  if (!opened.success) throw new Error(opened.error);
  store = opened.project;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const limits = {
  maxExportBytes: SANDBOX_LIMITS.maxExportBytes,
  maxBlobBytes: SANDBOX_LIMITS.maxBlobBytes,
};

describe("reapSandboxes", () => {
  it("removes orphan VMs and ends their runs failed with the rows that survived", async () => {
    const path = join(dir, "users", "alice", "workflow", "parked.workflow.json");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        format: "path/workflow@6",
        id: randomUUID(),
        name: "parked",
        body: [
          {
            type: "binary",
            id: randomUUID(),
            name: "a",
            command: "node",
            args: ["-e", "process.stdout.write('A')"],
          },
          { type: "person-activity", id: randomUUID(), name: "approve", description: "x" },
        ],
      }),
    );
    const loaded = await loadWorkflowTree(path);
    if (!loaded.success) throw new Error(loaded.errors.join("\n"));
    const { rootFile, workflowDir, files, registry } = loaded.workflow;

    // The Server dies while the VM, its run parked in the VM's store, is still up.
    let parked: (vm: FakeVm) => void = () => {};
    const vmUp = new Promise<FakeVm>((resolve) => {
      parked = resolve;
    });
    const dying = createSandboxedRuns(store, {
      runtime: fakeRuntime(async (vm) => {
        await inProcessVm(vm);
        parked(vm);
        return new Promise(() => {});
      }),
      slots: createVmSlots(1),
      image: "path-run:test",
      cpus: 1,
      memoryMiB: 512,
      timeoutMs: SANDBOX_LIMITS.timeoutMs,
      stopGraceMs: 10,
      hostEnv: {},
      ...limits,
    });
    const { rootRunId } = await dying.start(rootFile, workflowDir, { files, registry });
    await vmUp;

    const runtime = fakeRuntime(async () => 0, [`path-run-${rootRunId}`]);
    await reapSandboxes(dir, { runtime, ...limits });

    expect(runtime.removed).toEqual([`path-run-${rootRunId}`]);
    expect(existsSync(stagingDir(store, rootRunId))).toBe(false);
    const tree = store.archive.tree(rootRunId);
    expect(tree?.root?.status).toBe("failed");
    expect(tree?.runs.find((r) => r.nodeName === "a")?.status).toBe("succeeded");
    expect(tree?.events().at(-1)).toMatchObject({ error: "sandbox lost" });
  });

  it("does nothing on a host with no users", async () => {
    const runtime = fakeRuntime(async () => 0);
    await expect(
      reapSandboxes(join(dir, "empty"), { runtime, ...limits }),
    ).resolves.toBeUndefined();
  });
});
