import { describe, expect, it } from "vitest";
import { PathApiClient, PathApiError, type FetchLike } from "../src/api-client.js";

/** A `fetch` stub that records the last requested URL and returns a canned response. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    urls.push(input);
    return handler(input, init);
  };
  return { fetch, urls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("PathApiClient", () => {
  it("GET /v0/runs lists root runs and encodes limit/status query params", async () => {
    const stub = stubFetch(() => json({ runs: [{ run_id: "r1", status: "succeeded", started_at: "t0", finished_at: "t1" }] }));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080/", fetch: stub.fetch });

    const res = await client.listRuns({ limit: 10, status: "running" });
    expect(res.runs[0]?.run_id).toBe("r1");
    expect(stub.urls[0]).toBe("http://localhost:8080/v0/runs?limit=10&status=running");
  });

  it("GET /v0/runs/:id returns the run tree", async () => {
    const stub = stubFetch(() => json({ root_run_id: "r1", status: "succeeded", output: { ok: true }, runs: [] }));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    const tree = await client.getRun("r1");
    expect(tree.status).toBe("succeeded");
    expect(tree.output).toEqual({ ok: true });
    expect(stub.urls[0]).toBe("http://localhost:8080/v0/runs/r1");
  });

  it("GET blob route builds the :root/:run/:name path", async () => {
    const stub = stubFetch(() => json({ draft: "hello" }));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    const blob = await client.getBlob("r1", "c2", "output");
    expect(blob).toEqual({ draft: "hello" });
    expect(stub.urls[0]).toBe("http://localhost:8080/v0/runs/r1/blobs/c2/output");
  });

  it("POST /v0/runs/:id/cancel sends no body and percent-encodes the id", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const stub = stubFetch((_url, init) => {
      inits.push(init);
      return json({ root_run_id: "r 1" }, 202);
    });
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await expect(client.cancelRun("r 1")).resolves.toBeUndefined();
    expect(stub.urls[0]).toBe("http://localhost:8080/v0/runs/r%201/cancel");
    expect(inits[0]?.method).toBe("POST");
    expect(inits[0]?.body).toBeUndefined();
    expect(inits[0]?.headers).toEqual({ Accept: "application/json" });
  });

  it("cancelRun resolves on a 202 whose body is empty, which it never reads", async () => {
    const stub = stubFetch(() => new Response(null, { status: 202 }));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await expect(client.cancelRun("r1")).resolves.toBeUndefined();
  });

  it("DELETE /v0/runs/:id sends no body and percent-encodes the id", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const stub = stubFetch((_url, init) => {
      inits.push(init);
      return json({ root_run_id: "r 1" }, 200);
    });
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await expect(client.deleteRun("r 1")).resolves.toBeUndefined();
    expect(stub.urls[0]).toBe("http://localhost:8080/v0/runs/r%201");
    expect(inits[0]?.method).toBe("DELETE");
    expect(inits[0]?.body).toBeUndefined();
  });

  it("deleteRun appends ?force=true only when force is set", async () => {
    const stub = stubFetch(() => json({ root_run_id: "r1" }, 200));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await client.deleteRun("r1", { force: true });
    expect(stub.urls[0]).toBe("http://localhost:8080/v0/runs/r1?force=true");
  });

  it.each([
    [404, "an unknown or already-deleted run", `no run found with id "r1"`],
    [409, "a run still running", `run "r1" is still running; cancel it before deleting`],
  ])("deleteRun surfaces the %i for %s with its status and message", async (status, _case, message) => {
    const stub = stubFetch(() => json({ error: { message } }, status));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await expect(client.deleteRun("r1")).rejects.toMatchObject({ name: "PathApiError", status, message });
  });

  // One 409 is enough — the client cannot tell an already-terminal run from one this server process
  // is not executing, and does not try to; that the route sends both is `server.test.ts`'s to prove.
  it.each([
    [404, "an unknown run", `no run found with id "r1"`],
    [409, "a run that cannot be cancelled", `run "r1" already finished with status "succeeded"`],
  ])("cancelRun surfaces the %i for %s with its status and the server's message", async (status, _case, message) => {
    const stub = stubFetch(() => json({ error: { message } }, status));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await expect(client.cancelRun("r1")).rejects.toMatchObject({ name: "PathApiError", status, message });
  });

  it("cancelRun still raises a status-only PathApiError when the error body is not JSON", async () => {
    const stub = stubFetch(() => new Response("<html>502</html>", { status: 502 }));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await expect(client.cancelRun("r1")).rejects.toMatchObject({
      name: "PathApiError",
      status: 502,
      message: "request failed with status 502",
    });
  });

  it("POST /v0/runs/:id/resume sends no body, encodes the id, and returns the successor ids", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const stub = stubFetch((_url, init) => {
      inits.push(init);
      return json({ run_id: "successor", root_run_id: "successor" }, 202);
    });
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    const res = await client.resumeRun("r 1");
    expect(res).toEqual({ run_id: "successor", root_run_id: "successor" });
    expect(stub.urls[0]).toBe("http://localhost:8080/v0/runs/r%201/resume");
    expect(inits[0]?.method).toBe("POST");
    expect(inits[0]?.body).toBeUndefined();
    expect(inits[0]?.headers).toEqual({ Accept: "application/json" });
  });

  it("resumeRun sends { config } as a JSON body when a config override is given", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const stub = stubFetch((_url, init) => {
      inits.push(init);
      return json({ run_id: "successor", root_run_id: "successor" }, 202);
    });
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await client.resumeRun("r1", { output_file: "OUT.md" });
    expect(inits[0]?.method).toBe("POST");
    expect(inits[0]?.body).toBe(JSON.stringify({ config: { output_file: "OUT.md" } }));
    expect(inits[0]?.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it.each([
    [404, "an unknown run or a missing workflow file", `no run found with id "r1"`],
    [409, "a run that is not resumable", `run "r1" already succeeded; there is nothing to resume`],
    [400, "a workflow that no longer validates", "workflow validation failed"],
  ])("resumeRun surfaces the %i for %s with its status and message", async (status, _case, message) => {
    const stub = stubFetch(() => json({ error: { message } }, status));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await expect(client.resumeRun("r1")).rejects.toMatchObject({ name: "PathApiError", status, message });
  });

  it("POST /v0/runs translates camelCase options to the snake_case body and returns the wire reply", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const stub = stubFetch((_url, init) => {
      inits.push(init);
      return json({ run_id: "r1", root_run_id: "r1" }, 202);
    });
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    const res = await client.startRun({
      workflowPath: "release-notes.workflow.json",
      input: { tag: "v1" },
      config: { model: "sonnet" },
      logBackends: ["db", "ndjson"],
      llmConcurrency: 4,
    });

    expect(res).toEqual({ run_id: "r1", root_run_id: "r1" });
    expect(stub.urls[0]).toBe("http://localhost:8080/v0/runs");
    expect(inits[0]?.method).toBe("POST");
    expect(inits[0]?.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json" });
    expect(JSON.parse(inits[0]?.body as string)).toEqual({
      workflow_path: "release-notes.workflow.json",
      input: { tag: "v1" },
      config: { model: "sonnet" },
      log_backends: ["db", "ndjson"],
      llm_concurrency: 4,
    });
  });

  it("startRun omits every unset optional field, sending only workflow_path", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const stub = stubFetch((_url, init) => {
      inits.push(init);
      return json({ run_id: "r1", root_run_id: "r1" }, 202);
    });
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await client.startRun({ workflowPath: "wf.workflow.json" });
    expect(JSON.parse(inits[0]?.body as string)).toEqual({ workflow_path: "wf.workflow.json" });
  });

  it("startRun surfaces a 400 validation failure as a PathApiError with the server's details", async () => {
    const stub = stubFetch(() => json({ error: { message: "invalid config", details: { field: "$env" } } }, 400));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await expect(client.startRun({ workflowPath: "wf.workflow.json" })).rejects.toMatchObject({
      name: "PathApiError",
      status: 400,
      message: "invalid config",
      details: { field: "$env" },
    });
  });

  it("GET /v0/workflows returns the raw discovery list, roots flagged", async () => {
    const stub = stubFetch(() =>
      json({
        workflows: [
          { relative_path: "release-notes.workflow.json", id: "w1", name: "release-notes", valid: true, is_root: true, error: null },
          { relative_path: "broken.workflow.json", id: null, name: null, valid: false, is_root: null, error: { message: "bad JSON" } },
        ],
      }),
    );
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    const res = await client.listWorkflows();
    expect(res.workflows[0]).toMatchObject({ relative_path: "release-notes.workflow.json", is_root: true });
    expect(res.workflows[1]).toMatchObject({ valid: false, is_root: null, error: { message: "bad JSON" } });
    expect(stub.urls[0]).toBe("http://localhost:8080/v0/workflows");
  });

  it("raises PathApiError carrying the server's error envelope on non-2xx", async () => {
    const stub = stubFetch(() => json({ error: { message: "no run found", details: { id: "nope" } } }, 404));
    const client = new PathApiClient({ baseUrl: "http://localhost:8080", fetch: stub.fetch });

    await expect(client.getRun("nope")).rejects.toMatchObject({
      name: "PathApiError",
      status: 404,
      message: "no run found",
      details: { id: "nope" },
    });
    await expect(client.getRun("nope")).rejects.toBeInstanceOf(PathApiError);
  });
});
