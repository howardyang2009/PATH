import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

/**
 * `POST /v0/runs/:step_run_id/complete` to spec §4.4 (#485, ADR 0040/0041). The path names the parked
 * **leaf**; the server derives the root for the lease. These drive a real server over the built-in
 * `person-activity` plugin: each launches a workflow that parks at an `awaiting` leaf, then Completes
 * that leaf and asserts on the taxonomy and the persisted tree. The contract #485 adds over the #484
 * wiring is **validate-before-lease**: a bad `output` is a `400` with ajv issues and never takes the
 * lease, so it can never block a sibling.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let projectDir: string;
let handle: PathServerHandle;

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "path-server-complete-test-"));
  cpSync(fixturesDir, projectDir, { recursive: true });
  handle = await startPathServer(projectDir);
});

afterEach(async () => {
  await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

interface RunRow {
  run_id: string;
  node_id: string | null;
  status: string;
}
interface RunTreeBody {
  root_run_id: string;
  status: string;
  output: unknown;
  runs: RunRow[];
}

async function launch(workflowPath: string): Promise<string> {
  const res = await fetch(`${handle.url}/v0/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_path: workflowPath }),
  });
  expect(res.status).toBe(202);
  const { root_run_id } = (await res.json()) as { root_run_id: string };
  return root_run_id;
}

async function tree(rootRunId: string): Promise<RunTreeBody> {
  const res = await fetch(`${handle.url}/v0/runs/${rootRunId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as RunTreeBody;
}

/** The one `awaiting` leaf of a parked tree — the run id the Complete route keys on. */
async function awaitingLeafId(rootRunId: string): Promise<string> {
  const t = await tree(rootRunId);
  const leaf = t.runs.find((r) => r.status === "awaiting");
  if (!leaf) throw new Error(`no awaiting leaf in tree ${rootRunId}`);
  return leaf.run_id;
}

function complete(stepRunId: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${handle.url}/v0/runs/${stepRunId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Poll the root until it leaves `running` — the tail drives in the background after a `202`. */
async function settle(rootRunId: string): Promise<RunTreeBody> {
  for (let i = 0; i < 100; i++) {
    const t = await tree(rootRunId);
    if (t.status !== "running") return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`tree ${rootRunId} never settled`);
}

describe("valid output → 202, lease, CAS, tail in background", () => {
  it("validates, commits the leaf succeeded, returns both ids, and runs the tail", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);

    const res = await complete(leafId, { output: { approved: true } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ step_run_id: leafId, root_run_id: rootRunId });

    const settled = await settle(rootRunId);
    expect(settled.status).toBe("succeeded");
    expect(settled.runs.find((r) => r.run_id === leafId)!.status).toBe("succeeded");
    // The tail after the parked leaf ran in the same tree.
    expect(settled.runs.some((r) => r.node_id === "f599b76c-2230-4eca-8020-5d1287aa13e9")).toBe(true);
  });

  it("accepts any JSON when the node declares no outputSchema", async () => {
    const rootRunId = await launch("awaiting-no-schema.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);

    const res = await complete(leafId, { output: { anything: [1, "two", null] } });
    expect(res.status).toBe(202);

    const settled = await settle(rootRunId);
    expect(settled.status).toBe("succeeded");
  });
});

describe("validate-before-lease: invalid output → 400 with ajv issues, leaf untouched", () => {
  it("refuses output that fails the node's outputSchema and leaves the leaf awaiting", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);

    const res = await complete(leafId, { output: { approved: "yes" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; details?: unknown } };
    expect(body.error.details).toBeDefined();
    expect(Array.isArray(body.error.details)).toBe(true);

    // The leaf is untouched — still awaiting, still completable with corrected output.
    const t = await tree(rootRunId);
    expect(t.runs.find((r) => r.run_id === leafId)!.status).toBe("awaiting");
    expect(t.status).toBe("running");

    // A corrected resubmit to the same route now succeeds.
    const retry = await complete(leafId, { output: { approved: false } });
    expect(retry.status).toBe(202);
    expect((await settle(rootRunId)).status).toBe("succeeded");
  });

  it("refuses an output missing a required property", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);
    const res = await complete(leafId, { output: {} });
    expect(res.status).toBe(400);
  });

  it("still rejects a missing output field as 400", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);
    const res = await complete(leafId, {});
    expect(res.status).toBe(400);
  });

  it("interpolates the outputSchema against config before validating (ADR 0040)", async () => {
    const rootRunId = await launch("awaiting-config-schema.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);

    // The schema's `enum: ["${config.allowed}"]` resolves to `["high"]` from the file's config.
    expect((await complete(leafId, { output: { level: "low" } })).status).toBe(400);
    expect((await complete(leafId, { output: { level: "high" } })).status).toBe(202);
    expect((await settle(rootRunId)).status).toBe("succeeded");
  });

  it("accepts an optional config override, and applies the same $env reject as a launch (ADR 0012/0046)", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);

    // An `$env` in the override would let a browser operator read the server's environment — the one
    // divergence ADR 0012 pins, and it holds on this door too.
    const envRes = await complete(leafId, { output: { approved: true }, config: { token: { $env: "PATH_TOKEN" } } });
    expect(envRes.status).toBe(400);
    const refusal = (await envRes.json()) as { error: { message: string } };
    expect(refusal.error.message).toContain("may not source from the server environment");

    // A literal `$secret` is the sanctioned channel, and the run proceeds.
    const res = await complete(leafId, { output: { approved: true }, config: { token: { $secret: "t" } } });
    expect(res.status).toBe(202);
    expect((await settle(rootRunId)).status).toBe("succeeded");
  });

  it("rejects an unknown body field rather than ignoring it", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);
    const res = await complete(leafId, { output: { approved: true }, configg: {} });
    expect(res.status).toBe(400);
  });
});

describe("error taxonomy", () => {
  it("404 for an unknown step_run_id", async () => {
    const res = await complete("00000000-0000-4000-8000-000000000000", { output: { approved: true } });
    expect(res.status).toBe(404);
  });

  it("409 naming the actual status on a double-submit", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);

    expect((await complete(leafId, { output: { approved: true } })).status).toBe(202);
    await settle(rootRunId);

    const res = await complete(leafId, { output: { approved: true } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("succeeded");
  });

  it("404 when the recorded workflow file is gone", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);
    rmSync(join(projectDir, "awaiting-complete.workflow.json"));
    const res = await complete(leafId, { output: { approved: true } });
    expect(res.status).toBe(404);
  });

  it("409 when the node was retyped away from person-activity mid-wait", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);
    // Same node id, different type: the parked leaf can never validly complete against this file.
    const retyped = {
      format: "path/workflow@5",
      id: "84c0b1d1-9372-4e9c-9fce-5db6f10b4865",
      name: "awaiting-complete",
      body: [
        {
          type: "binary",
          id: "3408257a-0c34-437b-a93e-041ad4dc52aa",
          name: "review",
          command: "node",
          args: ["-e", "process.stdout.write('x')"],
        },
      ],
    };
    writeFileSync(join(projectDir, "awaiting-complete.workflow.json"), JSON.stringify(retyped));
    const res = await complete(leafId, { output: { approved: true } });
    expect(res.status).toBe(409);
  });

  it("409 when the file at the recorded path is now a different workflow (id changed)", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);
    // A parkable leaf with the *same* node id, type and schema, under a different workflow id: the
    // node lookup alone would match it, so only the run's recorded identity can refuse this file.
    const swapped = {
      format: "path/workflow@5",
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      name: "awaiting-complete",
      body: [
        {
          type: "person-activity",
          id: "3408257a-0c34-437b-a93e-041ad4dc52aa",
          name: "review",
          description: "a person reviews and submits an approval decision",
          outputSchema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"],
            additionalProperties: false,
          },
        },
      ],
    };
    writeFileSync(join(projectDir, "awaiting-complete.workflow.json"), JSON.stringify(swapped));

    const res = await complete(leafId, { output: { approved: true } });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("id changed");
  });

  it("403 for a cross-origin browser call", async () => {
    const rootRunId = await launch("awaiting-complete.workflow.json");
    const leafId = await awaitingLeafId(rootRunId);
    const res = await complete(leafId, { output: { approved: true } }, { Origin: "http://evil.example" });
    expect(res.status).toBe(403);
    // The leaf was never touched by the rejected call.
    const t = await tree(rootRunId);
    expect(t.runs.find((r) => r.run_id === leafId)!.status).toBe("awaiting");
  });
});
