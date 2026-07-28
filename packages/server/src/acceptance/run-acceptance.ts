import { resolve } from "node:path";
import { readNdjsonLog } from "@path/engine";
import { createEventFrameDecoder, eventStreamHeaders, type LogEvent } from "@path/schema";
import type { JsonValue } from "@path/schema";

/**
 * The §5 acceptance harness (server-api-spec.md §5): drives the four acceptance criteria for a
 * workflow entirely through a *running* `@path/server` over HTTP, and reports pass/fail per
 * criterion. The point of ticket #39 is that the existing engine pipeline becomes reachable over
 * HTTP — so this asserts the *server boundary*, reading `run.log` off disk (via the engine's own
 * `readNdjsonLog`) to confirm the streamed narrative matches what execution actually recorded.
 *
 * No new engine/server capability is exercised: `POST` to start, `GET /events` to stream (with a
 * mid-run disconnect + `Last-Event-ID` reconnect), `GET /:id` for the run tree. Token-free against
 * a binary fixture (proving the mechanics); the human points it at `release-notes.workflow.json`
 * for the real, token-spending run.
 */

export interface CriterionResult {
  /** The spec §5 criterion number, "1".."4". */
  id: string;
  title: string;
  pass: boolean;
  detail: string;
}

export interface AcceptanceReport {
  rootRunId: string | undefined;
  status: string | undefined;
  /** Every event seq observed across the disconnect/reconnect, the assembled live narrative. */
  narrativeSeqs: number[];
  criteria: CriterionResult[];
  /** True only if every criterion passed. */
  passed: boolean;
}

export interface AcceptanceOptions {
  /** Base URL of an already-running `path-server` (e.g. `http://localhost:8080`). */
  url: string;
  /** The server's project root — where its `.path/runs/<id>/run.log` lives, read here for §5.2. */
  projectDir: string;
  /** Root workflow path, resolved against the project root by the server (same as `POST` body). */
  workflowPath: string;
  input?: { [key: string]: JsonValue };
  config?: { [key: string]: JsonValue };
  /**
   * How many SSE frames connection A reads before disconnecting mid-run (§5.4). Default 1 — one
   * frame proves the client saw live output, then it drops. On the minutes-long real pipeline this
   * is genuinely mid-run; on a sub-second fixture it still exercises the reconnect path.
   */
  disconnectAfterFrames?: number;
}

/**
 * Reads a response's events until `until` is satisfied (then aborts `controller` to disconnect
 * mid-stream) or the stream ends. The reconnect seq is taken from the event body's `seq`, which the
 * server also echoes as the frame's `id:`. The frame grammar is `@path/schema`'s, the same
 * definition the server encodes with — an acceptance run that decoded the wire its own way could
 * pass while a real client could not read a byte of it.
 */
async function readFrames(
  res: Response,
  until: ((frames: LogEvent[]) => boolean) | undefined,
  controller: AbortController | undefined,
): Promise<{ frames: LogEvent[]; ended: boolean }> {
  const reader = res.body!.getReader();
  const text = new TextDecoder();
  const decoder = createEventFrameDecoder();
  const frames: LogEvent[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { frames, ended: true };
      for (const frame of decoder.push(text.decode(value, { stream: true }))) frames.push(frame.event);
      if (until && until(frames)) {
        controller?.abort();
        return { frames, ended: false };
      }
    }
  } catch (err) {
    // Aborting mid-read (the deliberate disconnect) rejects the pending read — that's expected.
    if (controller?.signal.aborted) return { frames, ended: false };
    throw err;
  }
}

async function openEventStream(url: string, rootRunId: string, lastEventId: number | undefined, signal: AbortSignal | undefined): Promise<Response> {
  return fetch(`${url}/v0/runs/${rootRunId}/events`, { headers: eventStreamHeaders(lastEventId), signal });
}

interface RunTreeBody {
  root_run_id: string;
  status: string;
  runs: { run_id: string; parent_run_id: string | null; status: string }[];
}

function isContiguousFrom1(seqs: number[]): boolean {
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i + 1) return false;
  }
  return seqs.length > 0;
}

/** Polls the run tree until the root run reaches a terminal status, returning the final tree. */
async function pollTerminal(url: string, rootRunId: string): Promise<RunTreeBody> {
  for (;;) {
    const body = (await (await fetch(`${url}/v0/runs/${rootRunId}`)).json()) as RunTreeBody;
    if (body.status !== "pending" && body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Runs the four §5 criteria against a live server and returns a structured report. */
export async function runAcceptance(opts: AcceptanceOptions): Promise<AcceptanceReport> {
  const disconnectAfter = opts.disconnectAfterFrames ?? 1;
  const projectDir = resolve(opts.projectDir);
  const criteria: CriterionResult[] = [];

  // ── §5.1: POST /v0/runs starts the pipeline and returns a root_run_id ──────────────────────────
  const postRes = await fetch(`${opts.url}/v0/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_path: opts.workflowPath, input: opts.input, config: opts.config }),
  });
  const postBody = (await postRes.json().catch(() => ({}))) as { root_run_id?: string; run_id?: string; error?: unknown };
  const rootRunId = postBody.root_run_id;
  criteria.push({
    id: "1",
    title: "POST /v0/runs starts the pipeline and returns a root_run_id",
    pass: postRes.status === 202 && typeof rootRunId === "string",
    detail: postRes.status === 202 && rootRunId ? `202 Accepted, root_run_id=${rootRunId}` : `unexpected response ${postRes.status}: ${JSON.stringify(postBody)}`,
  });
  if (postRes.status !== 202 || !rootRunId) {
    return { rootRunId, status: undefined, narrativeSeqs: [], criteria, passed: false };
  }

  // ── §5.4: connect, disconnect mid-run, reconnect with Last-Event-ID, no gap ────────────────────
  // Connection A streams live and drops after `disconnectAfter` frames — the deliberate mid-run
  // disconnect. We then let the run finish and reconnect B from lastSeqA, so B deterministically
  // replays the *entire* window A missed out of `run.log` (not a timing race): the union of A and B
  // is the whole narrative iff the reconnect leaves no gap.
  const controllerA = new AbortController();
  const streamA = await openEventStream(opts.url, rootRunId, undefined, controllerA.signal);
  const { frames: framesA, ended: endedA } = await readFrames(
    streamA,
    (f) => f.length >= disconnectAfter,
    controllerA,
  );
  const lastSeqA = framesA.length > 0 ? framesA[framesA.length - 1]!.seq : 0;

  // Wait out the run before reconnecting — this is also §5.3's terminal tree.
  const tree = await pollTerminal(opts.url, rootRunId);

  const streamB = await openEventStream(opts.url, rootRunId, lastSeqA, undefined);
  const { frames: framesB } = await readFrames(streamB, undefined, undefined);

  const narrative = [...framesA, ...framesB];
  const narrativeSeqs = narrative.map((e) => e.seq);
  const firstBSeq = framesB.length > 0 ? framesB[0]!.seq : undefined;
  const contiguous = isContiguousFrom1(narrativeSeqs);
  // The disk narrative is the yardstick for "no gap": whatever run.log holds beyond lastSeqA is
  // exactly what the reconnect must have replayed, so the seam is real (not vacuously empty).
  const diskEvents = readNdjsonLog(projectDir, rootRunId);
  const expectedTail = diskEvents.filter((e) => e.seq > lastSeqA).length;
  const reconnectFilledSeam = framesB.length === expectedTail && (expectedTail === 0 || firstBSeq === lastSeqA + 1);
  criteria.push({
    id: "4",
    title: "disconnect mid-run, reconnect with Last-Event-ID, no gap in the narrative",
    pass: framesA.length > 0 && reconnectFilledSeam && contiguous,
    detail: `connection A read ${framesA.length} frame(s) (last seq ${lastSeqA}${endedA ? ", stream ended before disconnect" : ", disconnected mid-run"}); reconnect Last-Event-ID:${lastSeqA} replayed ${framesB.length} of ${expectedTail} tail event(s) from seq ${firstBSeq ?? "—"}; merged narrative ${narrativeSeqs.length} events, ${contiguous ? "contiguous 1.." + narrativeSeqs.length : "NOT contiguous"}`,
  });

  // ── §5.3: GET /v0/runs/:id reports succeeded with the same run tree on disk ─────────────────────
  // Beyond the API's own consistency, cross-check the tree against the on-disk narrative: every run
  // that emitted events in run.log must appear as a row in the tree GET returns.
  const rootRow = tree.runs.find((r) => r.parent_run_id === null);
  const succeeded = tree.status === "succeeded";
  const treeRunIds = new Set(tree.runs.map((r) => r.run_id));
  const diskRunIds = [...new Set(diskEvents.map((e) => e.run_id))];
  const treeCoversDisk = diskRunIds.every((id) => treeRunIds.has(id));
  criteria.push({
    id: "3",
    title: "GET /v0/runs/:id reports succeeded with the same run tree on disk",
    pass: succeeded && rootRow?.run_id === rootRunId && tree.runs.every((r) => r.status === "succeeded") && treeCoversDisk,
    detail: `status=${tree.status}, ${tree.runs.length} run row(s); ${diskRunIds.length} run(s) in run.log ${treeCoversDisk ? "all present in tree" : "MISSING from tree"}${succeeded ? "" : " (expected succeeded)"}`,
  });

  // ── §5.2: streamed narrative matches what run.log records on disk ───────────────────────────────
  // Full-event equality, not just seq: type, run_id, node_id and payload must all agree.
  const matchesDisk =
    diskEvents.length === narrative.length &&
    diskEvents.every((e, i) => JSON.stringify(e) === JSON.stringify(narrative[i]));
  criteria.push({
    id: "2",
    title: "GET /v0/runs/:id/events streams the full narrative, matching run.log on disk",
    pass: matchesDisk && diskEvents.length > 0,
    detail: `run.log recorded ${diskEvents.length} event(s); streamed narrative ${narrative.length} event(s); ${matchesDisk ? "identical event-for-event" : "MISMATCH"}`,
  });

  criteria.sort((a, b) => a.id.localeCompare(b.id));
  return { rootRunId, status: tree.status, narrativeSeqs, criteria, passed: criteria.every((c) => c.pass) };
}
