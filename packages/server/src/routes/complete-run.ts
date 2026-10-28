import { ConfigObjectSchema, type JsonValue } from "@path/schema";
import { z } from "zod";
import { type RouteReply, readRequestBody, replyError, replyRefused } from "../http-json.js";
import { runCommand } from "../run-command.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `POST /v0/runs/:step_run_id/complete` (server-api-v0.md §4.4) — resolve a parked `awaiting` leaf
 * with a person's output. The path names the leaf; the leaf CAS, the workflow reload and the
 * continuation are the shared run command's.
 */

/**
 * Body: `output` plus an optional `config` override — the door an operator re-supplies a
 * launch-frozen `$secret` through (ADR 0046). Same ADR 0012 `$env` reject as §2.
 */
const CompleteBodySchema = z
  .object({ output: z.unknown(), config: ConfigObjectSchema.optional() })
  .strict();

export async function handleCompleteRun({
  body,
  ctx,
  params: [stepRunId],
}: ApiRequest<[string]>): Promise<RouteReply> {
  const parsed = readRequestBody(body, CompleteBodySchema);
  if (!parsed.ok) return parsed.reply;
  const output = parsed.data.output as JsonValue;
  if (output === undefined) return replyError(400, "run.complete.missing-output");
  const config = parsed.data.config;

  const outcome = await runCommand({ kind: "complete", stepRunId, output, config }, ctx);
  if (!outcome.ok) return replyRefused(outcome.refusal);

  return { status: 202, body: { step_run_id: stepRunId, root_run_id: outcome.rootRunId } };
}
