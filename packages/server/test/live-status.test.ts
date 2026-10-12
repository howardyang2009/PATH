import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProject, type Project } from "@path/engine";
import { blankRunRecord, type LogEvent } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveRuns } from "../src/live-runs.js";
import { liveDisplayStatus } from "../src/live-status.js";
import { NO_BODY } from "../src/request-body.js";
import { handleGetRun } from "../src/routes/get-run.js";
import { handleListRuns } from "../src/routes/list-runs.js";
import type { RouteContext } from "../src/routes/route-context.js";

/**
 * A sandboxed tree's rows reach the host store only when its VM exits; until then the run surfaces
 * read the display status off the stored rows with the VM's streamed events folded in.
 */

const ROOT = "root-run";
const TS = "2026-10-12T10:00:00.000Z";
const envelope = { ts: TS, node_id: "node-guid", node_name: "check" };

let seq = 0;
const started = (runId: string, parentRunId?: string | null): LogEvent => ({
  type: "step-started",
  seq: ++seq,
  ...envelope,
  run_id: runId,
  step_type: "person-activity",
  worker_name: "person",
  ...(parentRunId !== undefined ? { parent_run_id: parentRunId } : {}),
});
const awaiting = (runId: string): LogEvent => ({
  type: "step-awaiting",
  seq: ++seq,
  ...envelope,
  run_id: runId,
  assignee: null,
});
const finished = (runId: string): LogEvent => ({
  type: "step-finished",
  seq: ++seq,
  ...envelope,
  run_id: runId,
  status: "succeeded",
});

const root = blankRunRecord({ runId: ROOT, rootRunId: ROOT, status: "running" });
const leaf = (status: "awaiting" | "running") =>
  blankRunRecord({ runId: "leaf", rootRunId: ROOT, parentRunId: ROOT, status });

describe("liveDisplayStatus", () => {
  it("reads a root `awaiting` once a leaf the store has not seen parks under it", () => {
    const display = liveDisplayStatus([root], [started("leaf", ROOT), awaiting("leaf")]);
    expect(display.get(ROOT)).toBe("awaiting");
    expect(display.get("leaf")).toBe("awaiting");
  });

  it("reads a root `running` again once the stored parked leaf finishes", () => {
    expect(liveDisplayStatus([root, leaf("awaiting")], []).get(ROOT)).toBe("awaiting");
    const display = liveDisplayStatus([root, leaf("awaiting")], [finished("leaf")]);
    expect(display.get(ROOT)).toBe("running");
    expect(display.get("leaf")).toBe("succeeded");
  });

  it("cannot place a started run with no parent, so it leaves the root as stored", () => {
    const display = liveDisplayStatus([root], [started("leaf"), awaiting("leaf")]);
    expect(display.get(ROOT)).toBe("running");
    expect(display.has("leaf")).toBe(false);
  });
});

describe("the run routes read the live display status", () => {
  let dir: string;
  let store: Project;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "path-server-live-status-test-"));
    const opened = openProject(dir);
    if (!opened.success) throw new Error(opened.error);
    store = opened.project;
    store.archive.recordRoot(ROOT, { status: "running", workflowId: "wf-id", workflowName: "wf" });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function request<Params extends string[]>(
    params: Params,
    unstored: LogEvent[],
    query: Record<string, string> = {},
  ) {
    const live = { unstored: (id: string) => (id === ROOT ? unstored : []) } as unknown as LiveRuns;
    return {
      req: {} as IncomingMessage,
      ctx: { store, live } as RouteContext,
      params,
      query: new URLSearchParams(query),
      body: NO_BODY,
    };
  }

  const parked = () => [started("leaf", ROOT), awaiting("leaf")];

  it("GET /v0/runs/:id answers the parked root `awaiting`", () => {
    const reply = handleGetRun(request<[string]>([ROOT], parked()));
    expect(reply).toMatchObject({ status: 200, body: { display_status: { [ROOT]: "awaiting" } } });
  });

  it("GET /v0/runs lists the parked root under `awaiting`, not under `running`", () => {
    const list = (status: string) => handleListRuns(request([], parked(), { status })).body;
    expect(handleListRuns(request([], parked())).body).toMatchObject({
      runs: [{ run_id: ROOT, status: "running", display_status: "awaiting" }],
    });
    expect(list("awaiting")).toMatchObject({ runs: [{ run_id: ROOT }] });
    expect(list("running")).toEqual({ runs: [] });
  });
});
