import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { formatIssues } from "@path/schema";
import { z } from "zod";
import { confineToProjectRoot } from "../confine.js";
import { readJsonBody, sendError, sendJson } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * The Designer edit-lock lease (ADR 0017, issue #364). The lease is a server-owned, expiring, file-based
 * marker `<name>.workflow.json.editing` that sits beside the workflow it guards. It is
 * Designer-to-Designer mutual exclusion so a second tab is *warned before the first keystroke*, and it
 * complements (never replaces) the write route's `If-Match` precondition (ADR 0016), which alone
 * protects the on-disk bytes against every writer.
 *
 * The marker file **is** the state: the server keeps no in-memory registry, so a restart neither loses
 * nor rebuilds a lease, and reclaim is lazy — an expired marker is evaluated only when someone next
 * tries to acquire *that* file (no startup sweep, no reaper).
 */

/** TTL 30s (ADR 0017): heartbeat every 10s, so a live tab beats three times per window; a crash frees the marker in ≤30s. */
const TTL_MS = 30_000;

/** The suffix the marker carries over the workflow path. Discovery is blind to it (fails `endsWith(".workflow.json")`) and `.gitignore` ignores it. */
const MARKER_SUFFIX = ".editing";

/**
 * The lease JSON the server authors. `session_id` is client-minted (a UUIDv4, ADR 0015's
 * client-mints-identity stance) and the only token a client presents. `acquired_at`/`heartbeat_at` are
 * server-stamped, and `expires_at = heartbeat_at + TTL` is server-computed — never read from the client
 * (a client-set expiry could pin a lease forever, ADR 0017).
 */
interface Lease {
  session_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

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
 * Resolve the marker path (`workflow_path + ".editing"`) inside the project root, reusing the write
 * door's confine/symlink stance verbatim (ADR 0017 decision 7): an escape or a traversed symlink is
 * `undefined`, folded into the write route's existing 404 escape class. `allowMissingTail` lets the
 * marker itself not exist yet (acquire may create it); a marker that already exists as a symlink is
 * still refused.
 */
function resolveMarker(ctx: RunsRouteContext, workflowPath: string): string | undefined {
  return confineToProjectRoot(resolve(ctx.project.dir), `${workflowPath}${MARKER_SUFFIX}`, {
    allowMissingTail: true,
  });
}

/**
 * Read the marker beside the workflow. `fileExists` distinguishes a bare "no marker" (a fresh grant may
 * use an exclusive `wx` create) from a present-but-unparseable marker (reclaimable — overwrite). A
 * corrupt marker parses to `lease: undefined` and is treated as expired.
 */
function readLease(absPath: string): { fileExists: boolean; lease?: Lease } {
  let bytes: string;
  try {
    bytes = readFileSync(absPath, "utf8");
  } catch {
    return { fileExists: false };
  }
  try {
    const parsed = JSON.parse(bytes) as Partial<Lease>;
    if (typeof parsed.session_id === "string" && typeof parsed.expires_at === "string") {
      return { fileExists: true, lease: parsed as Lease };
    }
  } catch {
    // A hand-mangled or truncated marker is not a valid lease; treat it as reclaimable.
  }
  return { fileExists: true };
}

/** Deterministic serialization, matching the write door: 2-space indent, trailing newline. */
function serializeLease(lease: Lease): string {
  return `${JSON.stringify(lease, null, 2)}\n`;
}

/**
 * `POST /v0/workflows/lock` (ADR 0017): acquire/takeover. Grants (`200` + lease) when no marker exists,
 * the marker is expired, the caller already holds it, or `takeover: true`. A **live** marker held by a
 * *different* `session_id` is a `409` carrying `held_by_other` + the holder's `expires_at`, so the UI
 * can say "someone is editing, expires in Ns" and offer takeover.
 *
 * `enforceSameOrigin` already gated this state-changing route centrally (cross-origin → 403). The
 * read-decide-write below is a single synchronous block (no `await`), so no other request of this
 * process interleaves — the same concurrency stance the write door takes.
 */
export async function handleWorkflowLock(req: IncomingMessage, res: ServerResponse, ctx: RunsRouteContext): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, "request body must be valid JSON");
    return;
  }
  const parsed = LockBodySchema.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, 400, "invalid request body", formatIssues(parsed.error));
    return;
  }
  const { workflow_path: workflowPath, session_id: sessionId, takeover } = parsed.data;

  const absPath = resolveMarker(ctx, workflowPath);
  if (absPath === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  const { fileExists, lease } = readLease(absPath);
  const now = Date.now();
  const live = lease !== undefined && now <= Date.parse(lease.expires_at);

  if (live && lease!.session_id !== sessionId && takeover !== true) {
    // A live marker held by another session: the lease conflict `409` (not the write door's byte-`412`).
    // Carry the holder's expiry so the UI can offer a timed takeover.
    sendJson(res, 409, {
      error: { message: "workflow is being edited in another session" },
      held_by_other: true,
      expires_at: lease!.expires_at,
    });
    return;
  }

  // A caller re-acquiring its own still-live lease keeps the original `acquired_at`; every other grant
  // (fresh, reclaim of an expired marker, takeover) starts a new lease window at `now`.
  const acquiredAt =
    live && lease!.session_id === sessionId ? lease!.acquired_at : new Date(now).toISOString();
  const granted: Lease = {
    session_id: sessionId,
    acquired_at: acquiredAt,
    heartbeat_at: new Date(now).toISOString(),
    expires_at: new Date(now + TTL_MS).toISOString(),
  };

  // A confined workflow may sit in an intermediate dir; ensure it, mirroring the write door. A fresh
  // grant (no marker on disk) uses `wx` so a marker that raced into existence fails rather than
  // clobbering; a reclaim/takeover overwrites.
  mkdirSync(dirname(absPath), { recursive: true });
  try {
    writeFileSync(absPath, serializeLease(granted), fileExists ? undefined : { flag: "wx" });
  } catch (err) {
    // Only reachable when another OS process created the marker between the read above and this
    // `wx` create (intra-process the read-decide-write block is synchronous). Fold it into the same
    // lease-conflict `409` a live holder gets, mirroring the write door's EEXIST handling, rather than
    // a 500.
    if (!fileExists && (err as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readLease(absPath).lease;
      sendJson(res, 409, {
        error: { message: "workflow was just locked in another session" },
        held_by_other: true,
        expires_at: raced?.expires_at,
      });
      return;
    }
    throw err;
  }
  sendJson(res, 200, granted);
}

/**
 * `POST /v0/workflows/lock/heartbeat` (ADR 0017): renew. When the marker is present and its `session_id`
 * matches, rewrite `heartbeat_at`/`expires_at` (preserving `acquired_at`) → `200` + lease. When the
 * marker is absent (expired-and-reclaimed) or held under a different `session_id` (taken over) → `409`;
 * the client stops beating and offers re-acquire.
 */
export async function handleWorkflowLockHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, "request body must be valid JSON");
    return;
  }
  const parsed = LeaseOpBodySchema.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, 400, "invalid request body", formatIssues(parsed.error));
    return;
  }
  const { workflow_path: workflowPath, session_id: sessionId } = parsed.data;

  const absPath = resolveMarker(ctx, workflowPath);
  if (absPath === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  const { lease } = readLease(absPath);
  if (lease === undefined || lease.session_id !== sessionId) {
    sendError(res, 409, "editing lease not held by this session");
    return;
  }

  const now = Date.now();
  const renewed: Lease = {
    ...lease,
    heartbeat_at: new Date(now).toISOString(),
    expires_at: new Date(now + TTL_MS).toISOString(),
  };
  writeFileSync(absPath, serializeLease(renewed));
  sendJson(res, 200, renewed);
}

/**
 * `POST /v0/workflows/lock/release` (ADR 0017): free. Always `200`, idempotent (already-gone is
 * success). It deletes the marker **only** when `session_id` matches, so a stale `sendBeacon` from a
 * closing tab can never free someone else's lease. POST, not DELETE, because `navigator.sendBeacon`
 * drives release from `beforeunload` and is POST-only.
 */
export async function handleWorkflowLockRelease(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, "request body must be valid JSON");
    return;
  }
  const parsed = LeaseOpBodySchema.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, 400, "invalid request body", formatIssues(parsed.error));
    return;
  }
  const { workflow_path: workflowPath, session_id: sessionId } = parsed.data;

  const absPath = resolveMarker(ctx, workflowPath);
  if (absPath === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  const { lease } = readLease(absPath);
  let released = false;
  if (lease !== undefined && lease.session_id === sessionId) {
    rmSync(absPath, { force: true });
    released = true;
  }
  sendJson(res, 200, { released });
}
