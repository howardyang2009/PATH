import { ConfigObjectSchema, type StartRunResponse } from "@path/schema";
import { z } from "zod";
import { type RouteReply, readRequestBody, replyRefused } from "../http-json.js";
import { runCommand } from "../run-command.js";
import type { ApiRequest } from "./route-context.js";

/** Optional `config` override, and `rerun_from_run_id` — the rerun boundary K's source run id (ADR
 * 0032). */
const ResumeBodySchema = z
  .object({ config: ConfigObjectSchema.optional(), rerun_from_run_id: z.string().optional() })
  .strict();

/**
 * `POST /v0/runs/:root_run_id/resume` (server-api-v0.md §4.3) — re-runs a finished-but-unsuccessful
 * root run as a **successor** (ADR 0001). No `input`: a resumed run restores its context from the
 * predecessor's tree, so a fresh seed would be discarded. The address lookup, the path gate and the
 * live call are the shared run command's.
 */
export async function handleResumeRun({
  body,
  ctx,
  params: [rootRunId],
}: ApiRequest<[string]>): Promise<RouteReply> {
  const parsed = readRequestBody(body, ResumeBodySchema);
  if (!parsed.ok) return parsed.reply;
  const { config, rerun_from_run_id: rerunFromRunId } = parsed.data;

  const outcome = await runCommand({ kind: "resume", rootRunId, config, rerunFromRunId }, ctx);
  if (!outcome.ok) return replyRefused(outcome.refusal);

  const started: StartRunResponse = { run_id: outcome.runId, root_run_id: outcome.rootRunId };
  return { status: 202, body: started };
}
