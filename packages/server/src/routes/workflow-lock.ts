import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { type EditLease, editLease } from "../edit-lease.js";
import { type RouteReply, readRequestBody, replyError } from "../http-json.js";
import type { ApiRequest, RouteContext } from "./route-context.js";

/**
 * The three Designer edit-lease doors (ADR 0017): acquire, heartbeat, release. The lease itself
 * lives in `edit-lease.ts`.
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

/** The shared prologue: parse the body, find the named workflow's lease; a refusal is the reply. */
async function leaseRequest<T extends { workflow_path: string }>(
  req: IncomingMessage,
  ctx: RouteContext,
  schema: z.ZodType<T>,
): Promise<{ ok: true; body: T; lease: EditLease } | { ok: false; reply: RouteReply }> {
  const body = await readRequestBody(req, schema);
  if (!body.ok) return body;
  const lease = editLease(ctx.project.dir, body.data.workflow_path);
  if (lease === undefined) return { ok: false, reply: replyError(404, "not found") };
  return { ok: true, body: body.data, lease };
}

/** `POST /v0/workflows/lock`: acquire or take over; a live lease held by another session is a
 * `409`. */
export async function handleWorkflowLock({ req, ctx }: ApiRequest): Promise<RouteReply> {
  const request = await leaseRequest(req, ctx, LockBodySchema);
  if (!request.ok) return request.reply;
  const result = request.lease.acquire(request.body.session_id, request.body.takeover === true);
  return result.ok ? { status: 200, body: result.lease } : { status: 409, body: result.held };
}

/** `POST /v0/workflows/lock/heartbeat`: renew; a reclaimed or taken-over lease is a `409`. */
export async function handleWorkflowLockHeartbeat({ req, ctx }: ApiRequest): Promise<RouteReply> {
  const request = await leaseRequest(req, ctx, LeaseOpBodySchema);
  if (!request.ok) return request.reply;
  const renewed = request.lease.renew(request.body.session_id);
  return renewed
    ? { status: 200, body: renewed }
    : replyError(409, "editing lease not held by this session");
}

/**
 * `POST /v0/workflows/lock/release`: free; always `200`, idempotent, and only the holder's own
 * lease. POST, not DELETE, because `navigator.sendBeacon` drives release from `beforeunload` and is
 * POST-only.
 */
export async function handleWorkflowLockRelease({ req, ctx }: ApiRequest): Promise<RouteReply> {
  const request = await leaseRequest(req, ctx, LeaseOpBodySchema);
  if (!request.ok) return request.reply;
  return { status: 200, body: { released: request.lease.release(request.body.session_id) } };
}
