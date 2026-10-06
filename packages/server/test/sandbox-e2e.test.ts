import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowTree, openProject, type Project } from "@path/engine";
import type { LogEvent } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appleContainerRuntime } from "../src/sandbox/apple-container.js";
import { createSandboxedRuns, SANDBOX_LIMITS } from "../src/sandbox/sandboxed-runs.js";
import { createVmSlots } from "../src/sandbox/vm-slots.js";

/**
 * A Start in a real Apple `container` VM. Runs only when `PATH_SANDBOX_E2E_IMAGE` names a run image
 * built by `sandbox/build-run-image.sh`.
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

async function start(script: string, timeoutMs: number = SANDBOX_LIMITS.timeoutMs) {
  const path = join(dir, "users", "alice", "workflow", "probe.workflow.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      format: "path/workflow@6",
      id: randomUUID(),
      name: "probe",
      config: { token: { $env: "API_TOKEN" } },
      body: [
        {
          type: "binary",
          id: randomUUID(),
          name: "probe",
          command: "sh",
          args: ["-c", script],
          publish: { seen: "${output}" },
        },
      ],
      output: { seen: "${context.seen}" },
    }),
  );
  const loaded = await loadWorkflowTree(path);
  if (!loaded.success) throw new Error(loaded.errors.join("\n"));
  const { rootFile, workflowDir, files, registry } = loaded.workflow;
  const runs = createSandboxedRuns(store, {
    runtime: appleContainerRuntime(),
    slots: createVmSlots(SANDBOX_LIMITS.maxVms),
    image: image ?? "",
    cpus: 2,
    memoryMiB: 1024,
    timeoutMs,
    stopGraceMs: 10_000,
    maxExportBytes: SANDBOX_LIMITS.maxExportBytes,
    maxBlobBytes: SANDBOX_LIMITS.maxBlobBytes,
    hostEnv: {},
  });
  const started = await runs.start(rootFile, workflowDir, {
    files,
    registry,
    userSecrets: { API_TOKEN: "sk-alice" },
  });
  const events: LogEvent[] = [];
  runs.stream(started.rootRunId, undefined, { onEvent: (e) => events.push(e), onEnd: () => {} });
  await runs.idle();
  return { tree: store.archive.tree(started.rootRunId), events };
}

describe.skipIf(!image)("a Start in a real VM", () => {
  it("runs, streams and imports, with only the launcher's secrets in the environment", async () => {
    process.env.HOST_ONLY_SECRET = "owner";
    try {
      const { tree, events } = await start(
        'printf "%s|%s|%s" "$API_TOKEN" "$(printenv HOST_ONLY_SECRET || echo unset)" "$(jq --version)"',
      );
      expect(tree?.root?.status).toBe("succeeded");
      expect(tree?.output()).toEqual({ seen: "[secret:API_TOKEN]|unset|jq-1.6" });
      expect(events.map((e) => e.type)).toContain("step-finished");
    } finally {
      delete process.env.HOST_ONLY_SECRET;
    }
  }, 120_000);

  it("stops a run at its time limit", async () => {
    const { tree } = await start("exec sleep 600", 15_000);
    expect(tree?.root?.status).toBe("cancelled");
  }, 120_000);
});
