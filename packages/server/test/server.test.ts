import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

interface RunTreeBody {
  root_run_id: string;
  status: string;
  output: unknown;
  runs: {
    run_id: string;
    root_run_id: string;
    parent_run_id: string | null;
    node_id: string | null;
    status: string;
  }[];
}

let projectDir: string;
let handle: PathServerHandle;

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "path-server-test-"));
  cpSync(fixturesDir, projectDir, { recursive: true });
  handle = await startPathServer(projectDir);
});

afterEach(async () => {
  await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

async function postRun(body: unknown): Promise<Response> {
  return fetch(`${handle.url}/v0/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function getRun(rootRunId: string): Promise<Response> {
  return fetch(`${handle.url}/v0/runs/${rootRunId}`);
}

interface RootRunSummary {
  run_id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
}

async function listRuns(query = ""): Promise<Response> {
  return fetch(`${handle.url}/v0/runs${query}`);
}

async function pollUntilTerminal(rootRunId: string): Promise<RunTreeBody> {
  for (;;) {
    const body = (await (await getRun(rootRunId)).json()) as RunTreeBody;
    if (body.status !== "pending" && body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("startPathServer", () => {
  it("binds to an ephemeral port by default and reports a usable URL", () => {
    expect(handle.url).toMatch(/^http:\/\/localhost:\d+$/);
  });
});

describe("POST /v0/runs + GET /v0/runs/:root_run_id — end to end", () => {
  it("starts a run and returns before it finishes, then the tree reports succeeded with snake_case fields", async () => {
    const postRes = await postRun({ workflow_path: "two-binary-steps.workflow.json" });
    expect(postRes.status).toBe(202);
    const started = (await postRes.json()) as { run_id: string; root_run_id: string };
    expect(started.run_id).toBe(started.root_run_id);
    expect(started.run_id).toMatch(/^[0-9a-f-]{36}$/);

    const finalBody = await pollUntilTerminal(started.root_run_id);
    expect(finalBody.status).toBe("succeeded");
    expect(finalBody.output).toEqual({ shouted: "HELLO" });
    expect(finalBody.root_run_id).toBe(started.root_run_id);

    const root = finalBody.runs.find((r) => r.parent_run_id === null)!;
    expect(root.run_id).toBe(started.root_run_id);
    expect(root.node_id).toBeNull();
    expect(new Set(finalBody.runs.map((r) => r.node_id))).toEqual(new Set([null, "greet", "shout"]));
    expect(finalBody.runs.every((r) => r.status === "succeeded")).toBe(true);
    expect(finalBody.runs.every((r) => r.root_run_id === started.root_run_id)).toBe(true);
  });

  it("reports running (with null output) while the workflow is still executing", async () => {
    const postRes = await postRun({ workflow_path: "slow-step.workflow.json" });
    expect(postRes.status).toBe(202);
    const { root_run_id } = (await postRes.json()) as { root_run_id: string };

    const body = (await (await getRun(root_run_id)).json()) as RunTreeBody;
    expect(body.status).toBe("running");
    expect(body.output).toBeNull();

    const finalBody = await pollUntilTerminal(root_run_id);
    expect(finalBody.status).toBe("succeeded");
    expect(finalBody.output).toEqual({ result: "done" });
  });

  it("runs multiple concurrent POSTs without queueing", async () => {
    const start = Date.now();
    const [a, b] = await Promise.all([
      postRun({ workflow_path: "slow-step.workflow.json" }),
      postRun({ workflow_path: "slow-step.workflow.json" }),
    ]);
    const elapsed = Date.now() - start;
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    // Each step alone sleeps 300ms; queued execution would take ~600ms to both accept.
    expect(elapsed).toBeLessThan(250);

    const idsA = (await a.json()) as { root_run_id: string };
    const idsB = (await b.json()) as { root_run_id: string };
    expect(idsA.root_run_id).not.toBe(idsB.root_run_id);

    const [finalA, finalB] = await Promise.all([
      pollUntilTerminal(idsA.root_run_id),
      pollUntilTerminal(idsB.root_run_id),
    ]);
    expect(finalA.status).toBe("succeeded");
    expect(finalB.status).toBe("succeeded");
  });

  it("400s when workflow_path is missing", async () => {
    const res = await postRun({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBeTruthy();
  });

  it("400s on a malformed JSON body", async () => {
    const res = await postRun("{not json");
    expect(res.status).toBe(400);
  });

  it("400s with validation details when the workflow file fails schema validation", async () => {
    const res = await postRun({ workflow_path: "invalid-schema.workflow.json" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; details: string[] } };
    expect(body.error.details.join("\n")).toContain("bogus_field");
  });

  it("404s when the workflow file does not exist", async () => {
    const res = await postRun({ workflow_path: "does-not-exist.workflow.json" });
    expect(res.status).toBe(404);
  });

  it("404s when workflow_path resolves outside the project root", async () => {
    const res = await postRun({ workflow_path: "../../etc/passwd" });
    expect(res.status).toBe(404);
  });

  it("GET /v0/runs lists root runs most-recent-first, with limit and status filters", async () => {
    const first = (await (await postRun({ workflow_path: "two-binary-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilTerminal(first.root_run_id);
    const second = (await (await postRun({ workflow_path: "two-binary-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilTerminal(second.root_run_id);

    const res = await listRuns();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: RootRunSummary[] };
    // Most-recent-first, and the summary shape only (no tree, no output).
    expect(body.runs.map((r) => r.run_id)).toEqual([second.root_run_id, first.root_run_id]);
    expect(Object.keys(body.runs[0]!).sort()).toEqual(["finished_at", "run_id", "started_at", "status"]);
    expect(body.runs[0]!.status).toBe("succeeded");
    expect(body.runs[0]!.started_at).toBeTruthy();

    const limited = (await (await listRuns("?limit=1")).json()) as { runs: RootRunSummary[] };
    expect(limited.runs.map((r) => r.run_id)).toEqual([second.root_run_id]);

    const succeeded = (await (await listRuns("?status=succeeded")).json()) as { runs: RootRunSummary[] };
    expect(succeeded.runs).toHaveLength(2);
    const failed = (await (await listRuns("?status=failed")).json()) as { runs: RootRunSummary[] };
    expect(failed.runs).toHaveLength(0);
  });

  it("400s GET /v0/runs on an invalid limit or status", async () => {
    expect((await listRuns("?limit=nope")).status).toBe(400);
    expect((await listRuns("?limit=0")).status).toBe(400);
    expect((await listRuns("?status=bogus")).status).toBe(400);
  });

  it("404s GET for an unknown root_run_id", async () => {
    const res = await getRun("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("00000000-0000-0000-0000-000000000000");
  });
});
