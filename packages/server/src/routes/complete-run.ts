import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonValue } from "@path/schema";
import { readJsonBody, sendError, sendJson } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * `POST /v0/runs/:step_run_id/complete` (#462) — resolves an awaiting step run with the provided
 * output. The step's `outputSchema` validation happens at the engine level when the output is
 * handed back to `settleStepResult` (the complete call resolves the deferred).
 */
export async function handleCompleteRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
  stepRunId: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, "invalid JSON body");
    return;
  }

  if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
    sendError(res, 400, "body must be a JSON object");
    return;
  }

  const { output } = body.value as { output?: JsonValue };
  if (output === undefined) {
    sendError(res, 400, 'missing required field "output"');
    return;
  }

  if (!ctx.live.complete(stepRunId, output)) {
    sendError(res, 404, `no awaiting step run found with id "${stepRunId}"`);
    return;
  }

  sendJson(res, 202, { step_run_id: stepRunId });
}
