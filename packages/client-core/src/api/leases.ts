import type {
  WireLeaseOpRequest,
  WireLockHeldBody,
  WireLockRequest,
  WireWorkflowLease,
} from "@path/schema";
import { type HttpTransport, parseReply, toApiError } from "./transport.js";

/** The Designer edit-lock lease (ADR 0017): `session_id` is client-minted, the timestamps are server-stamped, and
 * `expires_at` is computed by the server, never trusted from the client.
 */
export type WorkflowLease = WireWorkflowLease;

/** The camelCase input to a lock acquire/takeover (`POST /v0/workflows/lock`, ADR 0017). */
export interface AcquireLockInput {
  /** The workflow's `/`-bearing relative path — the body field, not a URL segment. */
  workflowPath: string;
  sessionId: string;
  /** `true` overwrites a live marker held by another session — gate it behind an explicit user confirm. */
  takeover?: boolean;
}

/** The camelCase input to a heartbeat or a release. */
export interface LeaseOpInput {
  workflowPath: string;
  sessionId: string;
}

/** The outcome of an acquire: `held-by-other` is the `409` a **live** marker under another session takes, carrying the
 * holder's `expires_at` — a normal result here, not a `PathApiError`.
 */
export type AcquireLockResult =
  | { status: "granted"; lease: WorkflowLease }
  | { status: "held-by-other"; expiresAt: string | null };

/** The outcome of a heartbeat: `lost` is the `409` a reclaimed or taken-over marker returns, so the client stops
 * beating.
 */
export type HeartbeatResult = { status: "renewed"; lease: WorkflowLease } | { status: "lost" };

export async function acquireLock(
  http: HttpTransport,
  input: AcquireLockInput,
): Promise<AcquireLockResult> {
  const body: WireLockRequest = {
    workflow_path: input.workflowPath,
    session_id: input.sessionId,
  };
  if (input.takeover !== undefined) body.takeover = input.takeover;
  const { status, text } = await http.send("/v0/workflows/lock", { method: "POST", body });
  if (status === 200) return { status: "granted", lease: parseReply<WorkflowLease>(status, text) };
  if (status === 409)
    return {
      status: "held-by-other",
      expiresAt: parseReply<WireLockHeldBody>(status, text).expires_at ?? null,
    };
  throw toApiError(status, text);
}

export async function heartbeatLock(
  http: HttpTransport,
  input: LeaseOpInput,
): Promise<HeartbeatResult> {
  const { status, text } = await http.send("/v0/workflows/lock/heartbeat", {
    method: "POST",
    body: leaseOpBody(input),
  });
  if (status === 200) return { status: "renewed", lease: parseReply<WorkflowLease>(status, text) };
  if (status === 409) return { status: "lost" };
  throw toApiError(status, text);
}

export async function releaseLock(http: HttpTransport, input: LeaseOpInput): Promise<void> {
  await http.request("/v0/workflows/lock/release", { method: "POST", body: leaseOpBody(input) });
}

function leaseOpBody(input: LeaseOpInput): WireLeaseOpRequest {
  return { workflow_path: input.workflowPath, session_id: input.sessionId };
}
