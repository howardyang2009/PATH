import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { type EditLease, editLease } from "../edit-lease.js";
import { readRequestBody, sendError, sendJson } from "../http-json.js";
import type { ApiRequest, RouteContext } from "./route-context.js";

/**
 * The three Designer edit-lease doors (ADR 0017, issue #364): acquire, heartbeat and release. The lease
 * itself — its marker file, TTL, liveness and takeover rules — is `edit-lease.ts`; each door here only
 * parses its body and maps the lease's answer to a status. `enforceSameOrigin` already gated all three
 * centrally (cross-origin → 403).
 */

/** `POST /v0/workflows/lock` body — acquire/takeover. */
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

/**
 * The prologue every lease door shares: parse the body, and find the lease of the named workflow. An
 * escaping or symlinked marker path is the write door's `404` escape class. `undefined` once a refusal
 * has been sent.
 */
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

/**
 * `POST /v0/workflows/lock`: acquire or take over → `200` + lease. A live lease held by another session
 * is a `409` carrying `held_by_other` and the holder's `expires_at` (a lease conflict, not the write
 * door's byte-`412`).
 */
export async function handleWorkflowLock({ req, res, ctx }: ApiRequest): Promise<void> {
  const request = await leaseRequest(req, res, ctx, LockBodySchema);
  if (!request) return;
  const result = request.lease.acquire(request.body.session_id, request.body.takeover === true);
  if (result.ok) sendJson(res, 200, result.lease);
  else sendJson(res, 409, result.held);
}

/**
 * `POST /v0/workflows/lock/heartbeat`: renew → `200` + lease. A lease that was reclaimed or taken over
 * is a `409`; the client stops beating and offers re-acquire.
 */
export async function handleWorkflowLockHeartbeat({ req, res, ctx }: ApiRequest): Promise<void> {
  const request = await leaseRequest(req, res, ctx, LeaseOpBodySchema);
  if (!request) return;
  const renewed = request.lease.renew(request.body.session_id);
  if (renewed) sendJson(res, 200, renewed);
  else sendError(res, 409, "editing lease not held by this session");
}

/**
 * `POST /v0/workflows/lock/release`: free → always `200 { released }`, idempotent. Only the holder's own
 * lease is freed, so a stale `sendBeacon` from a closing tab can never free someone else's. POST, not
 * DELETE, because `navigator.sendBeacon` drives release from `beforeunload` and is POST-only.
 */
export async function handleWorkflowLockRelease({ req, res, ctx }: ApiRequest): Promise<void> {
  const request = await leaseRequest(req, res, ctx, LeaseOpBodySchema);
  if (!request) return;
  sendJson(res, 200, { released: request.lease.release(request.body.session_id) });
}
