import type { RunBlobName } from "@path/engine";
import { type RouteReply, replyError } from "../http-json.js";
import { resolveTree } from "./resolve-run.js";
import type { ApiRequest } from "./route-context.js";

/** The only blob names this route serves — a fixed set, so `name` is never a raw filename. */
const SERVED_BLOBS: RunBlobName[] = ["input", "output", "context"];

function toBlobName(name: string): RunBlobName | undefined {
  return SERVED_BLOBS.find((served) => served === name);
}

/**
 * `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — the run's on-disk blob, already secret-masked
 * at the persistence boundary; `input_ref`/`output_ref` are server-local paths a browser cannot
 * read. `404` for an unknown root/run, an unserved name, or an absent blob file.
 */
export function handleGetRunBlob({
  ctx,
  params: [rootRunId, runId, name],
}: ApiRequest<[string, string, string]>): RouteReply {
  const blobName = toBlobName(name);
  if (blobName === undefined) {
    return replyError(404, `unknown blob name "${name}" (expected "input", "output" or "context")`);
  }

  // An unknown root or a run_id outside it is the other 404 — asked separately from "no such blob".
  const address = resolveTree(ctx, rootRunId);
  if (!address.ok || !address.tree.has(runId)) {
    return replyError(404, `no run "${runId}" under root "${rootRunId}"`);
  }
  const { tree } = address;

  const blob = tree.blob(runId, blobName);
  if (blob === undefined) return replyError(404, `no ${name} blob for run "${runId}"`);

  return { status: 200, body: blob };
}
