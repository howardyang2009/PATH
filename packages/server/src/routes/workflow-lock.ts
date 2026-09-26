import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { type EditLease, editLease } from "../edit-lease.js";
import { readRequestBody, sendError, sendJson } from "../http-json.js";
import type { ApiRequest, RouteContext } from "./route-context.js";

/**
 * The three Designer edit-lease doors (ADR 0017): acquire, heartbeat, release. The lease itself lives
 * in `edit-lease.ts`.
 */

const LockBodySchema = z
  .object({
    workflow_path: z.string().min(1),
    session_id: z.string().min(1),
    takeover: z.boolean().optional(),
  })
  .strict();

/** `POST /v0/workflows/lock/heartbeat` and `.../release` body — renew/free. */
const LeaseOpBodySchema = z
  .object({
    workflow_path: z.string().min(1),
    session_id: z.string().min(1),
  })
  .strict();

/** The shared prologue: parse the body, find the named workflow's lease; `undefined` once refused. */
async function leaseRequest<T extends { workflow_path: string }>(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  schema: z.ZodType<T>,
): Promise<{ body: T; lease: EditLease } | undefined> {
  const body = await readRequestBody(req, res, schema);
  if (!body) return undefined;
  const lease = editLease(ctx.project.dir, body.data.workflow_path);
  if (lease === undefined) {
    sendError(res, 404, "not found");
    return undefined;
  }
  return { body: body.data, lease };
}

/** `POST /v0/workflows/lock`: acquire or take over; a live lease held by another session is a `409`. */
export async function handleWorkflowLock({ req, res, ctx }: ApiRequest): Promise<void> {
  const request = await leaseRequest(req, res, ctx, LockBodySchema);
  if (!request) return;
  const result = request.lease.acquire(request.body.session_id, request.body.takeover === true);
  if (result.ok) sendJson(res, 200, result.lease);
  else sendJson(res, 409, result.held);
}

/** `POST /v0/workflows/lock/heartbeat`: renew; a reclaimed or taken-over lease is a `409`. */
export async function handleWorkflowLockHeartbeat({ req, res, ctx }: ApiRequest): Promise<void> {
  const request = await leaseRequest(req, res, ctx, LeaseOpBodySchema);
  if (!request) return;
  const renewed = request.lease.renew(request.body.session_id);
  if (renewed) sendJson(res, 200, renewed);
  else sendError(res, 409, "editing lease not held by this session");
}

/**
 * `POST /v0/workflows/lock/release`: free; always `200`, idempotent, and only the holder's own lease.
 * POST, not DELETE, because `navigator.sendBeacon` drives release from `beforeunload` and is POST-only.
 */
export async function handleWorkflowLockRelease({ req, res, ctx }: ApiRequest): Promise<void> {
  const request = await leaseRequest(req, res, ctx, LeaseOpBodySchema);
  if (!request) return;
  sendJson(res, 200, { released: request.lease.release(request.body.session_id) });
}
