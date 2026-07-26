import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbFilePath, openDb, readNdjsonLog, type LogEvent } from "@path/engine";
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

async function getBlob(rootRunId: string, runId: string, name: string): Promise<Response> {
  return fetch(`${handle.url}/v0/runs/${rootRunId}/blobs/${runId}/${name}`);
}

interface SseFrame {
  id: string;
  data: { type: string; seq: number };
}

/** Reads an SSE response body to completion, parsing each `id:`/`data:` frame. */
async function readSseStream(res: Response): Promise<SseFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: SseFrame[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const idLine = block.split("\n").find((l) => l.startsWith("id: "));
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (idLine && dataLine) {
        frames.push({ id: idLine.slice(4), data: JSON.parse(dataLine.slice(6)) });
      }
    }
  }
  return frames;
}

async function cancelRun(rootRunId: string): Promise<Response> {
  return fetch(`${handle.url}/v0/runs/${rootRunId}/cancel`, { method: "POST" });
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

describe("GET /v0/runs/:root_run_id/blobs/:run_id/:name — run blob content", () => {
  it("serves a child run's input and output blobs as application/json", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-binary-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };
    const tree = await pollUntilTerminal(root_run_id);
    expect(tree.status).toBe("succeeded");
    const shout = tree.runs.find((r) => r.node_id === "shout")!;

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
    const shout = tree.runs.find((r) => r.node_id === "shout")!;

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
    for (const frame of frames) expect(frame.id).toBe(String(frame.data.seq));
    const seqs = frames.map((f) => f.data.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    // The run's own lifecycle events flow through: at least one step-started and one step-finished.
    const types = new Set(frames.map((f) => f.data.type));
    expect(types.has("step-started") || types.has("step-finished")).toBe(true);
    // The final frame is the root run finishing.
    expect(frames.at(-1)!.data.type).toBe("step-finished");

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
    const seqs = frames.map((f) => f.data.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(frames.at(-1)!.data.type).toBe("step-finished");
  });

  it("replays full history from seq 1 then continues live when connecting fresh (no Last-Event-ID)", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-slow-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`);
    const frames = await readSseStream(res);

    // Proves replay actually ran (not just "happened to connect before anything fired"): seq 1
    // (the root run's own step-started, already persisted before POST resolved) is present.
    expect(frames[0]!.data.seq).toBe(1);
    const seqs = frames.map((f) => f.data.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(frames.at(-1)!.data.type).toBe("step-finished");

    await pollUntilTerminal(root_run_id);
  });

  it("reconnecting with Last-Event-ID: N replays only seq > N, then continues live with no gap or duplicate", async () => {
    const { root_run_id } = (await (await postRun({ workflow_path: "two-slow-steps.workflow.json" })).json()) as {
      root_run_id: string;
    };

    const firstRes = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`);
    const reader = firstRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const firstFrames: SseFrame[] = [];
    while (firstFrames.length < 1) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const idLine = block.split("\n").find((l) => l.startsWith("id: "));
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (idLine && dataLine) firstFrames.push({ id: idLine.slice(4), data: JSON.parse(dataLine.slice(6)) });
      }
    }
    await reader.cancel(); // simulate the client disconnecting mid-run

    const lastSeenId = Number(firstFrames.at(-1)!.id);
    const secondRes = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`, {
      headers: { "Last-Event-ID": String(lastSeenId) },
    });
    const secondFrames = await readSseStream(secondRes);

    expect(secondFrames.every((f) => f.data.seq > lastSeenId)).toBe(true);
    const allSeqs = [...firstFrames.map((f) => Number(f.id)), ...secondFrames.map((f) => f.data.seq)];
    // Combined, the two connections cover the whole run with no gap and no duplicate.
    expect(allSeqs).toEqual(Array.from({ length: allSeqs.length }, (_, i) => i + 1));
    expect(secondFrames.at(-1)!.data.type).toBe("step-finished");

    await pollUntilTerminal(root_run_id);
  });

  it("running with ndjson disabled: connecting mid-run captures only events from connect time onward, no replay", async () => {
    const { root_run_id } = (await (await postRun({
      workflow_path: "two-slow-steps.workflow.json",
      log_backends: ["db"],
    })).json()) as { root_run_id: string };

    // Let the run's early events (its own step-started, and the first ~200ms step) fire before any
    // SSE subscriber exists — with no run.log to replay from, they're gone for good.
    await new Promise((r) => setTimeout(r, 250));

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`);
    const frames = await readSseStream(res);

    expect(frames.length).toBeGreaterThan(0);
    // Proves replay is genuinely unavailable (not just untested): the first frame we see is well
    // past seq 1, unlike the ndjson-enabled fresh-connect test above.
    expect(frames[0]!.data.seq).toBeGreaterThan(1);
    expect(frames.at(-1)!.data.type).toBe("step-finished");

    await pollUntilTerminal(root_run_id);
  });

  it("cannot replay history for a finished run whose ndjson backend was disabled (known v0 limitation)", async () => {
    const { root_run_id } = (await (
      await postRun({ workflow_path: "two-binary-steps.workflow.json", log_backends: ["db"] })
    ).json()) as { root_run_id: string };
    await pollUntilTerminal(root_run_id);

    const res = await fetch(`${handle.url}/v0/runs/${root_run_id}/events`);
    expect(res.status).toBe(200);
    const frames = await readSseStream(res);
    // No run.log for this run, and the channel's already closed (run finished) — nothing to
    // replay or forward, stream ends immediately.
    expect(frames).toEqual([]);
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
    expect(finalBody.runs.find((r) => r.node_id === "linger")!.status).toBe("cancelled");

    // The log tells the same story the rows do, and names the operator as the cause.
    const events: LogEvent[] = readNdjsonLog(projectDir, root_run_id);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "run-cancelled", node_id: "linger", cause: "operator", cause_run_id: null }),
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
