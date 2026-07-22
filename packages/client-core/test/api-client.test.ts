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
