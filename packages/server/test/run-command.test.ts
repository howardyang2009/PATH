import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedStepPluginRegistry, Project } from "@path/engine";
import type { RunRecord, WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import { authoredLayout } from "../src/authored-layout.js";
import type { LiveRuns, StartRunOptions } from "../src/live-runs.js";
import type { RouteContext } from "../src/routes/route-context.js";
import { runCommand } from "../src/run-command.js";
import type { WriteAccess } from "../src/write-access.js";

/**
 * The one run command behind the three run doors (ADR 0094): every arm owns the same prologue — the
 * `$env` reject, the path gate, the seams record — so this drives it against a recording `LiveRuns`
 * and a fake store, with no worker and no socket.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const WORKFLOW = "two-binary-steps.workflow.json";
const ROOT_ID = "root-run";

function runRow(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: ROOT_ID,
    rootRunId: ROOT_ID,
    parentRunId: null,
    nodeId: null,
    nodeName: null,
    workerName: null,
    iteration: null,
    pass: null,
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    inputRef: null,
    outputRef: null,
    usage: null,
    estimatedCostUsd: null,
    resumedFromRootRunId: null,
    rerunFromNodePath: null,
    reusedFromRunId: null,
    reusedFromRootRunId: null,
    workflowId: null,
    workflowName: "two",
    workflowPath: WORKFLOW,
    ...over,
  };
}

/** A `LiveRuns` whose three verbs record their call and answer fixed ids. */
function recordingLive(over: Partial<LiveRuns> = {}): {
  live: LiveRuns;
  starts: StartRunOptions[];
} {
  const starts: StartRunOptions[] = [];
  const live = {
    start: async (_file: WorkflowFile, _dir: string, options: StartRunOptions) => {
      starts.push(options);
      return { runId: "run-1", rootRunId: ROOT_ID };
    },
    resume: async () => ({ ok: true, runId: "run-2", rootRunId: "root-run-2" }),
    complete: async () => ({
      ok: true,
      rootRunId: ROOT_ID,
      status: "succeeded",
      output: null,
    }),
    ...over,
  } as unknown as LiveRuns;
  return { live, starts };
}

function context(live: LiveRuns, over: Partial<RouteContext> = {}): RouteContext {
  return {
    store: {} as unknown as Project,
    live,
    stepPlugins: {} as unknown as LoadedStepPluginRegistry,
    layout: authoredLayout({ projectDir: fixturesDir }),
    access: {} as unknown as WriteAccess,
    secrets: undefined,
    ...over,
  };
}

/** A store whose one tree holds a root row (and the leaf a complete door addresses). */
function storeWith(leaf?: RunRecord): Project {
  const runs = leaf === undefined ? [runRow()] : [runRow(), leaf];
  return {
    archive: {
      tree: (rootRunId: string) => (rootRunId === ROOT_ID ? { root: runRow(), runs } : null),
      rootRunIdOf: (stepRunId: string) =>
        runs.some((row) => row.runId === stepRunId) ? ROOT_ID : null,
    },
  } as unknown as Project;
}

describe("runCommand — start", () => {
  it("hands the live runs the workflow's seams and the launch table", async () => {
    const { live, starts } = recordingLive();
    const outcome = await runCommand(
      { kind: "start", workflowPath: WORKFLOW, launchWorkerDefaults: {} },
      context(live),
    );
    expect(outcome).toEqual({ ok: true, runId: "run-1", rootRunId: ROOT_ID });
    expect(starts).toHaveLength(1);
    expect(starts[0]?.files.size).toBeGreaterThan(0);
    expect(starts[0]?.sourceWorkflowPath).toBe(WORKFLOW);
  });

  it("refuses an operator config that sources $env before touching the filesystem (ADR 0012)", async () => {
    const { live, starts } = recordingLive();
    const outcome = await runCommand(
      { kind: "start", workflowPath: WORKFLOW, config: { token: { $env: "TOKEN" } } },
      context(live),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toMatchObject({ status: 400, code: "run.config-env" });
    expect(starts).toHaveLength(0);
  });

  it("400s a launch worker-default naming a worker the type does not ship (ADR 0044)", async () => {
    const { live } = recordingLive();
    const outcome = await runCommand(
      { kind: "start", workflowPath: WORKFLOW, launchWorkerDefaults: { binary: "no-such-worker" } },
      context(live),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.status).toBe(400);
    expect(outcome.refusal.code).toBe("run.invalid-worker-defaults");
  });

  it("404s a workflow the view does not hold", async () => {
    const { live } = recordingLive();
    const outcome = await runCommand(
      { kind: "start", workflowPath: "nope.workflow.json" },
      context(live),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toMatchObject({ status: 404, code: "workflow.not-found" });
  });

  it("answers 500 when the executor throws before a run exists", async () => {
    const live = {
      start: async () => {
        throw new Error("boom");
      },
    } as unknown as LiveRuns;
    const outcome = await runCommand({ kind: "start", workflowPath: WORKFLOW }, context(live));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toMatchObject({
      status: 500,
      code: "run.start-failed",
      params: { message: "boom" },
    });
  });
});

describe("runCommand — resume", () => {
  it("resumes the addressed root through the path gate", async () => {
    const { live } = recordingLive();
    const outcome = await runCommand(
      { kind: "resume", rootRunId: ROOT_ID },
      context(live, { store: storeWith() }),
    );
    expect(outcome).toEqual({ ok: true, runId: "run-2", rootRunId: "root-run-2" });
  });

  it("404s a root run the store does not hold", async () => {
    const { live } = recordingLive();
    const outcome = await runCommand(
      { kind: "resume", rootRunId: "missing" },
      context(live, { store: storeWith() }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toMatchObject({ status: 404, code: "run.not-found" });
  });
});

describe("runCommand — complete", () => {
  const LEAF = runRow({ runId: "leaf-1", parentRunId: ROOT_ID, status: "awaiting" });

  it("completes the addressed awaiting leaf and names its root", async () => {
    const { live } = recordingLive();
    const outcome = await runCommand(
      { kind: "complete", stepRunId: LEAF.runId, output: {} },
      context(live, { store: storeWith(LEAF) }),
    );
    expect(outcome).toEqual({ ok: true, runId: LEAF.runId, rootRunId: ROOT_ID });
  });

  it("409s a leaf that is no longer awaiting", async () => {
    const { live } = recordingLive();
    const outcome = await runCommand(
      { kind: "complete", stepRunId: LEAF.runId, output: {} },
      context(live, { store: storeWith({ ...LEAF, status: "succeeded" }) }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toMatchObject({ status: 409, code: "run.complete.not-awaiting" });
  });

  it("404s a step run the store does not hold", async () => {
    const { live } = recordingLive();
    const outcome = await runCommand(
      { kind: "complete", stepRunId: "missing", output: {} },
      context(live, { store: storeWith(LEAF) }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toMatchObject({ status: 404, code: "run.step-not-found" });
  });
});
