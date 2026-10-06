import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowTree, openProject, type Project } from "@path/engine";
import type { LogEvent, WorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveRuns, StartRunOptions } from "../src/live-runs.js";
import { appleContainerRuntime } from "../src/sandbox/apple-container.js";
import { createSandboxedRuns, SANDBOX_LIMITS } from "../src/sandbox/sandboxed-runs.js";
import { createVmSlots } from "../src/sandbox/vm-slots.js";

/**
 * The run lifecycle in real Apple `container` VMs. Runs only when `PATH_SANDBOX_E2E_IMAGE` names a
 * run image built by `sandbox/build-run-image.sh`.
 */
const image = process.env.PATH_SANDBOX_E2E_IMAGE;

let dir: string;
let store: Project;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "path-sandbox-e2e-")));
  const opened = openProject(join(dir, "users", "alice"));
  if (!opened.success) throw new Error(opened.error);
  store = opened.project;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function sandboxed(timeoutMs: number = SANDBOX_LIMITS.timeoutMs): LiveRuns {
  return createSandboxedRuns(store, {
    runtime: appleContainerRuntime(),
    slots: createVmSlots(SANDBOX_LIMITS.maxVms),
    image: image ?? "",
    cpus: 2,
    memoryMiB: 1024,
    timeoutMs,
    stopGraceMs: SANDBOX_LIMITS.stopGraceMs,
    maxExportBytes: SANDBOX_LIMITS.maxExportBytes,
    maxBlobBytes: SANDBOX_LIMITS.maxBlobBytes,
    hostEnv: {},
  });
}

const ids = new Map<string, string>();
const idFor = (name: string): string => {
  if (!ids.has(name)) ids.set(name, randomUUID());
  return ids.get(name) as string;
};

const shell = (name: string, script: string) => ({
  type: "binary",
  id: idFor(name),
  name,
  command: "sh",
  args: ["-c", script],
  publish: { [name]: "${output}" },
});
const park = { type: "person-activity", id: idFor("approve"), name: "approve", description: "x" };

/** Writes (or rewrites) a workflow under a fixed name and loads it. */
async function workflow(
  name: string,
  body: object[],
  extra: object = {},
): Promise<[WorkflowFile, string, StartRunOptions]> {
  const path = join(dir, "users", "alice", "workflow", `${name}.workflow.json`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ format: "path/workflow@6", id: idFor(name), name, body, ...extra }),
  );
  const loaded = await loadWorkflowTree(path);
  if (!loaded.success) throw new Error(loaded.errors.join("\n"));
  const { rootFile, workflowDir, files, registry } = loaded.workflow;
  return [rootFile, workflowDir, { files, registry, userSecrets: { API_TOKEN: "sk-alice" } }];
}

/** Resolves once the run has streamed a `step-started` for the step named `name`. */
async function stepStarted(runs: LiveRuns, rootRunId: string, name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = runs.stream(rootRunId, undefined, {
      onEvent: (event) => {
        if (event.type === "step-started" && event.node_name === name) {
          resolve();
          setImmediate(() => stop());
        }
      },
      onEnd: () => {},
    });
  });
}

describe.skipIf(!image)("the run lifecycle in real VMs", () => {
  it("runs a Start, streams and imports, with only the launcher's secrets in the environment", async () => {
    process.env.HOST_ONLY_SECRET = "owner";
    try {
      const runs = sandboxed();
      const started = await runs.start(
        ...(await workflow(
          "probe",
          [
            shell(
              "seen",
              'printf "%s|%s|%s" "$API_TOKEN" "$(printenv HOST_ONLY_SECRET || echo unset)" "$(jq --version)"',
            ),
          ],
          { config: { token: { $env: "API_TOKEN" } }, output: { seen: "${context.seen}" } },
        )),
      );
      const events: LogEvent[] = [];
      runs.stream(started.rootRunId, undefined, {
        onEvent: (e) => events.push(e),
        onEnd: () => {},
      });
      await runs.idle();
      const tree = store.archive.tree(started.rootRunId);
      expect(tree?.root?.status).toBe("succeeded");
      expect(tree?.output()).toEqual({ seen: "[secret:API_TOKEN]|unset|jq-1.6" });
      expect(events.map((e) => e.type)).toContain("step-finished");
    } finally {
      delete process.env.HOST_ONLY_SECRET;
    }
  }, 120_000);

  it("stops a run at its time limit", async () => {
    const runs = sandboxed(15_000);
    const { rootRunId } = await runs.start(
      ...(await workflow("slow", [shell("wait", "exec sleep 600")])),
    );
    await runs.idle();
    expect(store.archive.tree(rootRunId)?.root?.status).toBe("cancelled");
  }, 120_000);

  it("completes an awaiting run in a fresh VM", async () => {
    const runs = sandboxed();
    const wf = await workflow("parked", [shell("a", "printf A"), park, shell("b", "printf B")]);
    const { rootRunId } = await runs.start(...wf);
    await runs.idle();
    const leaf = store.archive.tree(rootRunId)?.runs.find((r) => r.status === "awaiting");

    const result = await runs.complete(wf[0], rootRunId, leaf?.runId ?? "", {}, wf[1], wf[2]);
    expect(result).toMatchObject({ ok: true, status: "succeeded" });
    expect(store.archive.tree(rootRunId)?.root?.status).toBe("succeeded");
  }, 180_000);

  it("ends a cancelled run within the grace period", async () => {
    const runs = sandboxed();
    const { rootRunId } = await runs.start(
      ...(await workflow("slow", [shell("wait", "exec sleep 600")])),
    );
    await stepStarted(runs, rootRunId, "wait");

    const asked = Date.now();
    runs.cancel(rootRunId);
    await runs.idle();
    expect(Date.now() - asked).toBeLessThan(SANDBOX_LIMITS.stopGraceMs + 5_000);
    expect(store.archive.tree(rootRunId)?.runs.every((r) => r.status === "cancelled")).toBe(true);
  }, 120_000);

  it("marks a killed VM's run failed with what its store kept, and resumes it", async () => {
    const runs = sandboxed();
    const wf = await workflow("flaky", [shell("a", "printf A"), shell("wait", "exec sleep 600")]);
    const { rootRunId } = await runs.start(...wf);
    await stepStarted(runs, rootRunId, "wait");

    execFileSync("container", ["kill", `path-run-${rootRunId}`]);
    await runs.idle();
    const tree = store.archive.tree(rootRunId);
    expect(tree?.root?.status).toBe("failed");
    expect(tree?.runs.find((r) => r.nodeName === "a")?.status).toBe("succeeded");
    expect(tree?.events().at(-1)).toMatchObject({ error: "sandbox lost" });

    const fixed = await workflow("flaky", [shell("a", "printf A"), shell("wait", "printf W")]);
    const successor = await runs.resume(fixed[0], rootRunId, fixed[1], fixed[2]);
    await runs.idle();
    expect(store.archive.tree(successor.rootRunId)?.root?.status).toBe("succeeded");
  }, 180_000);
});
