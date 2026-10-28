import { LOG_BACKEND_IDS } from "@path/engine";
import { ConfigObjectSchema, type JsonValue, type StartRunResponse } from "@path/schema";
import { z } from "zod";
import { type RouteReply, readRequestBody, replyRefused } from "../http-json.js";
import { runCommand } from "../run-command.js";
import type { ApiRequest } from "./route-context.js";

const PostRunsBodySchema = z
  .object({
    workflow_path: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
    config: ConfigObjectSchema.optional(),
    // The launch worker-default table (ADR 0044): a top-level peer of `input`/`config`. Shape-only
    // here; registry-relative validity is the launch-boundary check `runCommand` runs.
    worker_defaults: z.record(z.string().min(1), z.string().min(1)).optional(),
    log_backends: z.array(z.enum(LOG_BACKEND_IDS)).optional(),
    processor_concurrency: z.number().int().positive().optional(),
  })
  .strict();

/**
 * `POST /v0/runs` (server-api-v0.md §2) — start one workflow. The body is parsed here; the gate,
 * the launch-boundary worker-default check and the live call are the one run command every run door
 * shares (`run-command.ts`).
 */
export async function handlePostRuns({ body, ctx }: ApiRequest): Promise<RouteReply> {
  const parsed = readRequestBody(body, PostRunsBodySchema);
  if (!parsed.ok) return parsed.reply;
  const {
    workflow_path: workflowPath,
    input,
    config,
    worker_defaults: launchWorkerDefaults,
    log_backends: logBackends,
    processor_concurrency: processorConcurrency,
  } = parsed.data;

  const outcome = await runCommand(
    {
      kind: "start",
      workflowPath,
      input: input as { [key: string]: JsonValue } | undefined,
      config,
      launchWorkerDefaults,
      logBackends,
      processorConcurrency,
    },
    ctx,
  );
  if (!outcome.ok) return replyRefused(outcome.refusal);

  const started: StartRunResponse = { run_id: outcome.runId, root_run_id: outcome.rootRunId };
  return { status: 202, body: started };
}
