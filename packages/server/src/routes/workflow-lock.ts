import { z } from "zod";
import { type EditLease, editLease } from "../edit-lease.js";
import { type RouteReply, readRequestBody, replyError } from "../http-json.js";
import type { RequestBody } from "../request-body.js";
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

/** The shared prologue: parse the body, find the named workflow's lease; a refusal is the reply.
 * Only a requester who may change the file takes its lease, so a reader cannot block its writer. */
function leaseRequest<T extends { workflow_path: string }>(
  body: RequestBody,
  ctx: RouteContext,
  schema: z.ZodType<T>,
): { ok: true; body: T; lease: EditLease } | { ok: false; reply: RouteReply } {
  const parsed = readRequestBody(body, schema);
  if (!parsed.ok) return parsed;
  const target = ctx.access.workflow(parsed.data.workflow_path);
  if (!target.ok) return { ok: false, reply: replyError(target.status, target.message) };
  const lease = editLease(ctx.layout.projectDir, parsed.data.workflow_path);
  if (lease === undefined) return { ok: false, reply: replyError(404, "not found") };
  return { ok: true, body: parsed.data, lease };
}

/** `POST /v0/workflows/lock`: acquire or take over; a live lease held by another session is a
 * `409`. */
export async function handleWorkflowLock({ body, ctx }: ApiRequest): Promise<RouteReply> {
  const request = leaseRequest(body, ctx, LockBodySchema);
  if (!request.ok) return request.reply;
  const result = request.lease.acquire(request.body.session_id, request.body.takeover === true);
  return result.ok ? { status: 200, body: result.lease } : { status: 409, body: result.held };
}

/** `POST /v0/workflows/lock/heartbeat`: renew; a reclaimed or taken-over lease is a `409`. */
export async function handleWorkflowLockHeartbeat({ body, ctx }: ApiRequest): Promise<RouteReply> {
  const request = leaseRequest(body, ctx, LeaseOpBodySchema);
  if (!request.ok) return request.reply;
  const renewed = request.lease.renew(request.body.session_id);
  return renewed
    ? { status: 200, body: renewed }
    : replyError(409, "editing lease not held by this session");
}

/**
 * `POST /v0/workflows/lock/release`: free; always `200`, idempotent, and only the holder's own
 * lease. The Designer also sends it from `beforeunload` as a `keepalive` POST (ADR 0017).
 */
export async function handleWorkflowLockRelease({ body, ctx }: ApiRequest): Promise<RouteReply> {
  const request = leaseRequest(body, ctx, LeaseOpBodySchema);
  if (!request.ok) return request.reply;
  return { status: 200, body: { released: request.lease.release(request.body.session_id) } };
}
