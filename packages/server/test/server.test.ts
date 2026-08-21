import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbFilePath, openDb, readNdjsonLog } from "@path/engine";
import { createEventFrameDecoder, type EventFrame, type LogEvent } from "@path/schema";
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
    node_name: string | null;
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
  workflow_name: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
}

async function listRuns(query = ""): Promise<Response> {
  return fetch(`${handle.url}/v0/runs${query}`);
}

async function getBlob(rootRunId: string, runId: string, name: string): Promise<Response> {
  return fetch(`${handle.url}/v0/runs/${rootRunId}/blobs/${runId}/${name}`);
}


/**
 * Reads an SSE response body to completion. Decoded with the same codec a real client uses, so
 * these assertions are about what a client would actually see on the wire.
 */
async function readSseStream(res: Response): Promise<EventFrame[]> {
  const reader = res.body!.getReader();
  const text = new TextDecoder();
  const decoder = createEventFrameDecoder();
  const frames: EventFrame[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    frames.push(...decoder.push(text.decode(value, { stream: true })));
  }
  return frames;
}

async function cancelRun(rootRunId: string): Promise<Response> {
  return fetch(`${handle.url}/v0/runs/${rootRunId}/cancel`, { method: "POST" });
}

async function resumeRun(rootRunId: string, body?: unknown): Promise<Response> {
  return fetch(`${handle.url}/v0/runs/${rootRunId}/resume`, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

/**
 * Waits until a cancellable fixture's child process is genuinely alive, by watching for the marker
 * file it writes on startup (in the workflow file's directory — a binary step's default cwd).
 * A `running` run row is not enough: it is written by `runStarted`, *before* the process spawns, and
 * a cancel that lands in that window takes the engine's already-aborted fast path and never kills a
 * process at all — the opposite of what these tests mean to exercise.
 */
async function pollUntilStepAlive(marker: string): Promise<void> {
  const markerPath = join(projectDir, marker);
  while (!existsSync(markerPath)) await new Promise((r) => setTimeout(r, 10));
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
    expect(new Set(finalBody.runs.map((r) => r.node_name))).toEqual(new Set([null, "greet", "shout"]));
    expect(finalBody.runs.every((r) => r.status === "succeeded")).toBe(true);
    expect(finalBody.runs.every((r) => r.root_run_id === started.root_run_id)).toBe(true);
  });

  it("resolves a nested workflow ref against the workflow's own directory, not the project root (#59)", async () => {
    // The whole point is a workflow that does *not* sit at the project root: `runWorkflow`'s second
    // argument resolves `./child.workflow.json`, and passing `projectDir` there looked for the child
    // beside `.path/` instead of beside its parent, so it was never in the loaded tree. A fixture at
    // the root cannot catch this — the two directories are equal there.
    const postRes = await postRun({ workflow_path: "nested/parent.workflow.json" });
    expect(postRes.status).toBe(202);
    const { root_run_id } = (await postRes.json()) as { root_run_id: string };

    const finalBody = await pollUntilTerminal(root_run_id);
    expect(finalBody.status).toBe("succeeded");
    expect(finalBody.output).toEqual({ childResult: { shouted: "HI" } });
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
    // Each step alone sleeps 300ms; serialized execution would delay the second accept to ~600ms.
    // Concurrent accepts return in tens of ms, so the discriminator is the ~600ms queued floor, not
    // any tight budget: assert comfortably below it. A 250ms bar had no CI headroom (a slow runner
    // measured 319ms while genuinely concurrent, still nowhere near the 600ms serialized signal).
    expect(elapsed).toBeLessThan(500);

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

  // #280 / workflow-format-v2.md §1 — the server reads `@2` only, same as the CLI. A pre-migration
  // file is a 400 at load with the targeted codemod sentence, not a silent upconvert, so an API
  // client gets the same fix an operator reads on stderr.
  it("400s a superseded @1 workflow file, naming the codemod, and starts no run", async () => {
    writeFileSync(
      join(projectDir, "superseded.workflow.json"),
      JSON.stringify({
        format: "path/workflow@1",
        id: "af72905e-1cd4-4b83-9e07-32516da8bc4f",
        name: "superseded",
        worker: { type: "engine" },
        body: [{ type: "binary", id: "31e8d4b0-7a95-4162-ac2f-e0764b95d38a", name: "step-one", command: "echo" }],
      }),
    );

    const res = await postRun({ workflow_path: "superseded.workflow.json" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; details: string[] } };
    expect(body.error.details).toEqual([
      `${join(projectDir, "superseded.workflow.json")}: path/workflow@1 is no longer read — run scripts/migrate-workflow-format-v2.ts to migrate this file to path/workflow@2`,
    ]);

    const runs = (await (await listRuns()).json()) as { runs: RootRunSummary[] };
    expect(runs.runs).toEqual([]);
  });

  // ADR 0012 / #231 — operator-supplied override config may carry a literal `$secret` but must not
  // source from the server box's environment via `$env`. `ConfigObjectSchema` (shared with
  // workflow-authored config) accepts `$env`, so the reject is a post-parse walk on the operator
  // path only. `$env` authored *inside* a workflow.json is untouched.
  describe("operator config rejects $env ($secret literal still allowed)", () => {
    it("400s a bare {\"$env\": ...} in operator config, and starts no run", async () => {
      const res = await postRun({
        workflow_path: "two-binary-steps.workflow.json",
        config: { repo_path: { $env: "SECRET_X" } },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("$env");
      expect(body.error.message).toContain("repo_path");
      const listed = (await (await listRuns()).json()) as { runs: RootRunSummary[] };
      expect(listed.runs).toHaveLength(0);
    });

    it("400s the composed {\"$secret\": {\"$env\": ...}} form, reporting the config path", async () => {
      const res = await postRun({
        workflow_path: "two-binary-steps.workflow.json",
        config: { token: { $secret: { $env: "SECRET_X" } } },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("$env");
      // mapEnv walks *through* $secret, so the path is the config key, not `token.$secret`.
      expect(body.error.message).toContain("token");
    });

    it("accepts a literal {\"$secret\": \"...\"} in operator config", async () => {
      const res = await postRun({
        workflow_path: "two-binary-steps.workflow.json",
        config: { token: { $secret: "hunter2" } },
      });
      expect(res.status).toBe(202);
    });
  });

  it("404s when the workflow file does not exist", async () => {
    const res = await postRun({ workflow_path: "does-not-exist.workflow.json" });
    expect(res.status).toBe(404);
  });

  it("404s when workflow_path resolves outside the project root", async () => {
    const res = await postRun({ workflow_path: "../../etc/passwd" });
    expect(res.status).toBe(404);
  });

  // Issue #237 — the CSRF/origin gate on the state-changing routes. A cross-origin browser fetch
  // (another tab on a malicious site) carries `Sec-Fetch-Site: cross-site` or a mismatched `Origin`;
  // the viewer's own fetch and non-browser clients do not.
  describe("CSRF/origin gate (#237)", () => {
    async function postRunFrom(headers: Record<string, string>): Promise<Response> {
      return fetch(`${handle.url}/v0/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ workflow_path: "two-binary-steps.workflow.json" }),
      });
    }

    it("403s a POST /v0/runs with Sec-Fetch-Site: cross-site, and starts no run", async () => {
      const res = await postRunFrom({ "Sec-Fetch-Site": "cross-site" });
      expect(res.status).toBe(403);
      const listed = (await (await listRuns()).json()) as { runs: RootRunSummary[] };
      expect(listed.runs).toHaveLength(0);
    });

    it("403s a POST /v0/runs whose Origin does not match Host", async () => {
      const res = await postRunFrom({ Origin: "http://evil.com" });
      expect(res.status).toBe(403);
    });

    it("allows a POST /v0/runs with Sec-Fetch-Site: same-origin", async () => {
      const res = await postRunFrom({ "Sec-Fetch-Site": "same-origin" });
      expect(res.status).toBe(202);
    });

    it("allows a POST /v0/runs with no Origin/Sec-Fetch-Site (a non-browser client)", async () => {
      const res = await postRun({ workflow_path: "two-binary-steps.workflow.json" });
      expect(res.status).toBe(202);
    });

    it("allows a POST /v0/runs on the Origin-vs-Host fallback when Origin matches Host", async () => {
      // No Sec-Fetch-Site (an older browser), so the gate falls back to comparing Origin to Host.
      // The server's own URL is same-origin, so its host is exactly what a same-origin Origin carries.
      const res = await postRunFrom({ Origin: handle.url });
      expect(res.status).toBe(202);
    });

    it("403s a cross-origin cancel", async () => {
      const started = (await (await postRun({ workflow_path: "two-binary-steps.workflow.json" })).json()) as {
        root_run_id: string;
      };
      const res = await fetch(`${handle.url}/v0/runs/${started.root_run_id}/cancel`, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      expect(res.status).toBe(403);
    });
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
    expect(Object.keys(body.runs[0]!).sort()).toEqual([
      "finished_at",
      "run_id",
      "started_at",
      "status",
      "workflow_name",
    ]);
    expect(body.runs[0]!.status).toBe("succeeded");
    expect(body.runs[0]!.workflow_name).toBe("two-binary-steps");
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

describe("GET /v0/runs/:root_run_id/blobs/:run_id/:name — run blob content", () => {
  it("serves a child run's input and output blobs as application/json", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-binary-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };
    const tree = await pollUntilTerminal(root_run_id);
    expect(tree.status).toBe("succeeded");
    const shout = tree.runs.find((r) => r.node_name === "shout")!;

    const outputRes = await getBlob(root_run_id, shout.run_id, "output");
    expect(outputRes.status).toBe(200);
    expect(outputRes.headers.get("content-type")).toBe("application/json");
    expect(await outputRes.json()).toBe("HELLO");

    const inputRes = await getBlob(root_run_id, shout.run_id, "input");
    expect(inputRes.status).toBe(200);
    expect(inputRes.headers.get("content-type")).toBe("application/json");
    expect(await inputRes.json()).toBe("hello");
  });

  it("404s for an unknown run_id under a known root", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-binary-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilTerminal(root_run_id);

    const res = await getBlob(root_run_id, "00000000-0000-0000-0000-000000000000", "output");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBeTruthy();
  });

  it("404s for an unknown root_run_id", async () => {
    const res = await getBlob("00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000", "output");
    expect(res.status).toBe(404);
  });

  it("404s for an unknown blob name (only input/output are served)", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-binary-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };
    const tree = await pollUntilTerminal(root_run_id);
    const shout = tree.runs.find((r) => r.node_name === "shout")!;

    expect((await getBlob(root_run_id, shout.run_id, "stderr")).status).toBe(404);
    expect((await getBlob(root_run_id, shout.run_id, "context")).status).toBe(404);
  });
});

describe("GET /v0/runs/:root_run_id/events — live SSE stream", () => {
  it("streams live events in seq order, each frame carrying id: <seq>, and closes when the root finishes", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-slow-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Reading to completion only returns once the run reaches a terminal status at the root — the
    // server ends the stream there (no client-side timeout needed).
    const frames = await readSseStream(res);

    // Connected mid-run, so we see live events without polling.
    expect(frames.length).toBeGreaterThan(0);
    // Each frame's id is its event's seq, and seq is strictly ascending (the ordering truth).
    for (const frame of frames) expect(frame.id).toBe(String(frame.event.seq));
    const seqs = frames.map((f) => f.event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    // The run's own lifecycle events flow through: at least one step-started and one step-finished.
    const types = new Set(frames.map((f) => f.event.type));
    expect(types.has("step-started") || types.has("step-finished")).toBe(true);
    // The final frame is the root run finishing.
    expect(frames.at(-1)!.event.type).toBe("step-finished");

    const finalBody = await pollUntilTerminal(root_run_id);
    expect(finalBody.status).toBe("succeeded");
  });

  it("404s for an unknown root_run_id", async () => {
    const res = await fetch(`${handle.url}/v0/runs/00000000-0000-0000-0000-000000000000/events`);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it("replays the full persisted history from seq 1 for an already-finished run (no Last-Event-ID)", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-binary-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilTerminal(root_run_id);

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const frames = await readSseStream(res);

    expect(frames.length).toBeGreaterThan(0);
    const seqs = frames.map((f) => f.event.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(frames.at(-1)!.event.type).toBe("step-finished");
  });

  it("replays full history from seq 1 then continues live when connecting fresh (no Last-Event-ID)", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-slow-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`);
    const frames = await readSseStream(res);

    // Proves replay actually ran (not just "happened to connect before anything fired"): seq 1
    // (the root run's own step-started, already persisted before POST resolved) is present.
    expect(frames[0]!.event.seq).toBe(1);
    const seqs = frames.map((f) => f.event.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(frames.at(-1)!.event.type).toBe("step-finished");

    await pollUntilTerminal(root_run_id);
  });

  it("reconnecting with Last-Event-ID: N replays only seq > N, then continues live with no gap or duplicate", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-slow-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };

    const firstRes = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`);
    const reader = firstRes.body!.getReader();
    const text = new TextDecoder();
    const decoder = createEventFrameDecoder();
    const firstFrames: EventFrame[] = [];
    while (firstFrames.length < 1) {
      const { done, value } = await reader.read();
      if (done) break;
      firstFrames.push(...decoder.push(text.decode(value, { stream: true })));
    }
    await reader.cancel(); // simulate the client disconnecting mid-run

    const lastSeenId = Number(firstFrames.at(-1)!.id);
    const secondRes = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`, {
      headers: { "Last-Event-ID": String(lastSeenId) },
    });
    const secondFrames = await readSseStream(secondRes);

    expect(secondFrames.every((f) => f.event.seq > lastSeenId)).toBe(true);
    const allSeqs = [...firstFrames.map((f) => Number(f.id)), ...secondFrames.map((f) => f.event.seq)];
    // Combined, the two connections cover the whole run with no gap and no duplicate.
    expect(allSeqs).toEqual(Array.from({ length: allSeqs.length }, (_, i) => i + 1));
    expect(secondFrames.at(-1)!.event.type).toBe("step-finished");

    await pollUntilTerminal(root_run_id);
  });

  it("running with ndjson disabled: connecting mid-run still replays from seq 1, out of log_events", async () => {
    const { root_run_id } = (await (await postRun({
      workflow_path: "two-slow-steps.workflow.json",
      log_backends: ["db"],
    })).json()) as { root_run_id: string };

    // Let the run's early events (its own step-started, and the first ~200ms step) fire before any
    // SSE subscriber exists. There is no run.log, but every one of them is in `log_events`.
    await new Promise((r) => setTimeout(r, 250));

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`);
    const frames = await readSseStream(res);

    // Replay reaches back past the connect point, and the db replay meeting live events leaves no
    // gap and no duplicate across the join (`stream`'s lastSeq high-water mark).
    expect(frames[0]!.event.seq).toBe(1);
    const seqs = frames.map((f) => f.event.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(frames.at(-1)!.event.type).toBe("step-finished");
    // No run.log was written — this narrative can only have come from the table.
    expect(readNdjsonLog(projectDir, root_run_id)).toEqual([]);

    await pollUntilTerminal(root_run_id);
  });

  it("replays a finished run whose ndjson backend was disabled, from log_events", async () => {
    const { root_run_id } = (await (
      await postRun({ workflow_path: "two-binary-steps.workflow.json", log_backends: ["db"] })
    ).json()) as { root_run_id: string };
    await pollUntilTerminal(root_run_id);

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`);
    expect(res.status).toBe(200);
    const frames = await readSseStream(res);

    // No run.log and no open channel — the whole narrative comes out of the audit table.
    expect(readNdjsonLog(projectDir, root_run_id)).toEqual([]);
    expect(frames.length).toBeGreaterThan(0);
    const seqs = frames.map((f) => f.event.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(frames.at(-1)!.event.type).toBe("step-finished");
  });

  it("Last-Event-ID slices a db-only replay the same way it slices an ndjson one", async () => {
    const { root_run_id } = (await (
      await postRun({ workflow_path: "two-binary-steps.workflow.json", log_backends: ["db"] })
    ).json()) as { root_run_id: string };
    await pollUntilTerminal(root_run_id);

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`, {
      headers: { "Last-Event-ID": "2" },
    });
    const frames = await readSseStream(res);

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.event.seq).toBe(3);
    expect(frames.every((f) => f.event.seq > 2)).toBe(true);
  });
});

describe("POST /v0/runs/:root_run_id/cancel — cancel a run in flight", () => {
  /** Seeds a `running` root run row nothing in this process is executing — a CLI-launched run, or
   *  one left behind by a crashed server. Written straight to the same `.path/path.db` the server
   *  opened, which is exactly how `path run` makes such a row appear. */
  function seedForeignRunningRun(rootRunId: string): void {
    const db = openDb(dbFilePath(projectDir));
    try {
      db.prepare(
        `INSERT INTO runs (run_id, root_run_id, parent_run_id, node_id, worker, status, started_at)
         VALUES (?, ?, NULL, NULL, NULL, 'running', ?)`,
      ).run(rootRunId, rootRunId, new Date().toISOString());
    } finally {
      db.close();
    }
  }

  it("202s, and the run actually ends cancelled with the row and the NDJSON log agreeing", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "long-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    // Cancel while the step's child process is genuinely alive, not between nodes — otherwise the
    // kill path this route exists for never runs.
    await pollUntilStepAlive("long-step.alive");

    const res = await cancelRun(root_run_id);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ root_run_id });

    // The 202 went out before the run was terminal (§4.2) — the real end state arrives later.
    const finalBody = await pollUntilTerminal(root_run_id);
    expect(finalBody.status).toBe("cancelled");
    expect(finalBody.output).toBeNull();
    const root = finalBody.runs.find((r) => r.parent_run_id === null)!;
    expect(root.status).toBe("cancelled");
    expect(finalBody.runs.find((r) => r.node_name === "linger")!.status).toBe("cancelled");

    // The log tells the same story the rows do, and names the operator as the cause.
    const events: LogEvent[] = readNdjsonLog(projectDir, root_run_id);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "run-cancelled", node_name: "linger", cause: "operator", cause_run_id: null }),
    );
    expect(events.at(-1)).toMatchObject({ type: "step-finished", node_id: null, status: "cancelled" });
    // The 10s step was killed, not waited out: the fixture never got to publish its result.
    expect(events.some((e) => e.type === "step-finished" && e.node_id === "linger" && e.status === "succeeded")).toBe(
      false,
    );
  });

  it("404s for an unknown root_run_id", async () => {
    const res = await cancelRun("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("00000000-0000-0000-0000-000000000000");
  });

  it("409s for a run that already finished, naming the status it actually reached", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-binary-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };
    expect((await pollUntilTerminal(root_run_id)).status).toBe("succeeded");

    const res = await cancelRun(root_run_id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("succeeded");
  });

  it("409s for a run that already ended cancelled — a cancel is not repeatable once it lands", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "long-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilStepAlive("long-step.alive");
    expect((await cancelRun(root_run_id)).status).toBe(202);
    expect((await pollUntilTerminal(root_run_id)).status).toBe("cancelled");

    const res = await cancelRun(root_run_id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("cancelled");
  });

  it("404s rather than reading terminality off a child when the tree has no root row", async () => {
    // A tree whose root row is missing but whose child says `succeeded`. Guessing at any row of the
    // tree would answer "already finished with status succeeded" — a refused cancel of what may well
    // be a live run. Unreachable through the engine today; seeded here because the route's whole job
    // is to never answer off a row that isn't the root's.
    const rootRunId = "22222222-2222-2222-2222-222222222222";
    const db = openDb(dbFilePath(projectDir));
    try {
      db.prepare(
        `INSERT INTO runs (run_id, root_run_id, parent_run_id, node_id, worker, status, started_at)
         VALUES (?, ?, ?, 'orphan', NULL, 'succeeded', ?)`,
      ).run("33333333-3333-3333-3333-333333333333", rootRunId, rootRunId, new Date().toISOString());
    } finally {
      db.close();
    }

    const res = await cancelRun(rootRunId);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain("succeeded");
  });

  it("409s for a `running` row this server process is not executing, saying so distinctly", async () => {
    const foreignId = "11111111-1111-1111-1111-111111111111";
    seedForeignRunningRun(foreignId);
    // It is a real, visible run as far as every read endpoint is concerned.
    expect(((await (await getRun(foreignId)).json()) as RunTreeBody).status).toBe("running");

    const res = await cancelRun(foreignId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("not executing in this server process");
    // Distinct from the already-finished refusal — the operator can tell the two apart.
    expect(body.error.message).not.toContain("already finished");
  });

  it("answers 202 again on a repeated cancel of a still-unwinding run (double-click is safe)", async () => {
    // This fixture's step traps SIGTERM and takes ~600ms to go, so the unwind window the 202
    // contract exists for is real and observable here rather than a sub-millisecond race.
    const { root_run_id } = (await (await postRun({ workflow_path: "stubborn-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilStepAlive("stubborn-step.alive");

    const first = await cancelRun(root_run_id);
    expect(first.status).toBe(202);

    // The 202 really did go out before the run became terminal — it is a signal-sent receipt, not a
    // finished-cancelling one. Clients learn the terminal status from the stream they're watching.
    expect(((await (await getRun(root_run_id)).json()) as RunTreeBody).status).toBe("running");

    const second = await cancelRun(root_run_id);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ root_run_id });

    expect((await pollUntilTerminal(root_run_id)).status).toBe("cancelled");
  });

  it("is not swallowed by any other route: GET on the cancel path is a JSON 404, not a cancel", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "long-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilStepAlive("long-step.alive");

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/cancel`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    // The run is untouched — a GET must never abort anything.
    expect(((await (await getRun(root_run_id)).json()) as RunTreeBody).status).toBe("running");

    await cancelRun(root_run_id);
    await pollUntilTerminal(root_run_id);
  });
});

describe("POST /v0/runs/:root_run_id/resume — resume a finished-but-unsuccessful run", () => {
  it("202s resuming a failed run as a distinct successor that itself runs to terminal", async () => {
    const { root_run_id: original } = (await (await postRun({ workflow_path: "failing-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    expect((await pollUntilTerminal(original)).status).toBe("failed");

    const res = await resumeRun(original);
    expect(res.status).toBe(202);
    const { run_id, root_run_id: successor } = (await res.json()) as { run_id: string; root_run_id: string };
    // A resumed run is a *successor* (ADR 0001): its own fresh root id, never the predecessor's.
    expect(successor).not.toBe(original);
    expect(run_id).toBe(successor);

    // The successor is a real root run that runs the workflow again — failing-step fails again — and
    // its root row records the lineage back to the run it resumed.
    const successorBody = await pollUntilTerminal(successor);
    expect(successorBody.status).toBe("failed");
    const successorRoot = successorBody.runs.find((r) => r.parent_run_id === null)!;
    expect((successorRoot as unknown as { resumed_from_root_run_id: string }).resumed_from_root_run_id).toBe(original);
  });

  it("202s resuming a cancelled run", async () => {
    const { root_run_id: original } = (await (await postRun({ workflow_path: "long-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilStepAlive("long-step.alive");
    await cancelRun(original);
    expect((await pollUntilTerminal(original)).status).toBe("cancelled");

    const res = await resumeRun(original);
    expect(res.status).toBe(202);
    const { root_run_id: successor } = (await res.json()) as { root_run_id: string };
    expect(successor).not.toBe(original);
    // The successor exists as its own root run immediately.
    expect((await getRun(successor)).status).toBe(200);

    // It re-runs the long step; stop it so the suite doesn't wait the fixture out.
    await cancelRun(successor);
    await pollUntilTerminal(successor);
  });

  it("409s a run that is still running (nothing to resume yet)", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "long-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilStepAlive("long-step.alive");

    const res = await resumeRun(root_run_id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("still");

    await cancelRun(root_run_id);
    await pollUntilTerminal(root_run_id);
  });

  it("409s a run that already succeeded (nothing to resume)", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-binary-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };
    expect((await pollUntilTerminal(root_run_id)).status).toBe("succeeded");

    const res = await resumeRun(root_run_id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("succeeded");
  });

  it("404s for an unknown root_run_id", async () => {
    const res = await resumeRun("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "00000000-0000-0000-0000-000000000000",
    );
  });

  it("403s a cross-origin resume (state-changing route, #237 gate)", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "failing-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilTerminal(root_run_id);

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/resume`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("409s a run with no recorded workflow_path (a pre-#169 row it cannot re-run)", async () => {
    const rootRunId = "44444444-4444-4444-4444-444444444444";
    const db = openDb(dbFilePath(projectDir));
    try {
      db.prepare(
        `INSERT INTO runs (run_id, root_run_id, parent_run_id, node_id, worker, status, started_at, workflow_path)
         VALUES (?, ?, NULL, NULL, NULL, 'failed', ?, NULL)`,
      ).run(rootRunId, rootRunId, new Date().toISOString());
    } finally {
      db.close();
    }

    const res = await resumeRun(rootRunId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("no recorded workflow path");
  });

  it("404s when the recorded workflow file no longer exists on disk", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "failing-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    expect((await pollUntilTerminal(root_run_id)).status).toBe("failed");
    rmSync(join(projectDir, "failing-step.workflow.json"));

    const res = await resumeRun(root_run_id);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("failing-step.workflow.json");
  });

  it("400s when the recorded workflow file no longer passes validation", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "failing-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    expect((await pollUntilTerminal(root_run_id)).status).toBe("failed");
    // The file at that path is now schema-invalid — a resume of it is a 400, as a fresh launch would be.
    writeFileSync(join(projectDir, "failing-step.workflow.json"), JSON.stringify({ format: "path/workflow@2" }));

    const res = await resumeRun(root_run_id);
    expect(res.status).toBe(400);
  });

  // Resume re-validates the file as it stands *now*, so it is a load surface of its own (#280): a
  // file rolled back to `@1` under a finished run is a 400 naming the codemod, not an upconvert of
  // the version the run originally succeeded against.
  it("400s a resume whose recorded workflow file has been rolled back to @1, naming the codemod", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "failing-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    expect((await pollUntilTerminal(root_run_id)).status).toBe("failed");
    writeFileSync(
      join(projectDir, "failing-step.workflow.json"),
      JSON.stringify({
        format: "path/workflow@1",
        id: "af72905e-1cd4-4b83-9e07-32516da8bc4f",
        name: "failing-step",
        worker: { type: "engine" },
        body: [{ type: "binary", id: "31e8d4b0-7a95-4162-ac2f-e0764b95d38a", name: "boom", command: "false" }],
      }),
    );

    const res = await resumeRun(root_run_id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: string[] } };
    expect(body.error.details).toEqual([
      `${join(projectDir, "failing-step.workflow.json")}: path/workflow@1 is no longer read — run scripts/migrate-workflow-format-v2.ts to migrate this file to path/workflow@2`,
    ]);
  });

  it("accepts an optional config override on resume (202)", async () => {
    const { root_run_id: original } = (await (await postRun({ workflow_path: "failing-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    expect((await pollUntilTerminal(original)).status).toBe("failed");

    const res = await resumeRun(original, { config: { some_key: "override" } });
    expect(res.status).toBe(202);
    const { root_run_id: successor } = (await res.json()) as { root_run_id: string };
    expect(successor).not.toBe(original);
    await pollUntilTerminal(successor);
  });

  it("400s a resume whose config override carries an $env wrapper (ADR 0012)", async () => {
    const { root_run_id: original } = (await (await postRun({ workflow_path: "failing-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    expect((await pollUntilTerminal(original)).status).toBe("failed");

    const res = await resumeRun(original, { config: { token: { $secret: { $env: "SECRET_X" } } } });
    expect(res.status).toBe(400);
    const message = ((await res.json()) as { error: { message: string } }).error.message;
    expect(message).toContain("$env");
    expect(message).toContain("token");
  });

  it("400s a resume with a malformed JSON body", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "failing-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    await pollUntilTerminal(root_run_id);

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("409s when the file at the recorded path is now a different workflow (id changed)", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "failing-step.workflow.json" })).json()) as {
      root_run_id: string;
    };
    expect((await pollUntilTerminal(root_run_id)).status).toBe("failed");
    // A valid workflow, but not the one that ran — its id differs, so resuming the old run's context
    // into it would be running a workflow the operator never launched.
    writeFileSync(
      join(projectDir, "failing-step.workflow.json"),
      JSON.stringify({
        format: "path/workflow@2",
        id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        name: "swapped",
        worker: { type: "engine" },
        body: [{ type: "binary", id: "550e8400-e29b-41d4-a716-446655440000", name: "noop", command: "true", args: [] }],
      }),
    );

    const res = await resumeRun(root_run_id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("id changed");
  });
});
