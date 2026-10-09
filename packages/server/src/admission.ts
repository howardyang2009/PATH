import type { IncomingMessage } from "node:http";
import type { CreatorTable } from "./creator-table.js";
import { type RouteReply, replyError } from "./http-json.js";
import { type RequestBody, readBodyUnderCap } from "./request-body.js";
import {
  createRateLimiter,
  DEFAULT_LIMITS,
  type RequestLimits,
  type UserLimits,
} from "./request-limits.js";
import { createRunLimits, type RunRefusal } from "./run-limits.js";
import { type RunOwner, UNLIMITED } from "./sandbox/sandboxed-runs.js";
import { openVmUsage } from "./vm-usage.js";

// Admission (docs/spec/path-website.md §8): what one hosted user may do, decided in one place. A
// request passes its rate and body cap, a launch or an authored write its run limit, and each VM a
// launch queues for is held to the same limits again when it starts and when its rows import.

/** The run limit a route asks for before it is handled: a VM launch, or an authored write. */
export type AdmissionGate = "launch" | "write";

export interface Admission {
  /** The limits `userId` is held to; `undefined` in local mode, which has none. */
  limitsOf(userId: string): UserLimits | undefined;
  /** Counts one request of `userId` and reads its body under that user's cap — the one place a
   * request body is read (request-body.ts). Returns the requester's own body, or the `429`/`413`
   * refusal. A GET carries no body. */
  admitRequest(req: IncomingMessage, userId: string): Promise<AdmissionResult>;
  /** The refusal of `gate` for `userId` now, with its `Retry-After` when it has one. */
  gateRefusal(userId: string, gate: AdmissionGate): RouteReply | undefined;
  /** What the VMs `userId` launches are held to. */
  runOwner(userId: string): RunOwner;
  close(): void;
}

/** A request's admission verdict: the body it may act on, or the reply that refuses it. */
export type AdmissionResult = { ok: true; body: RequestBody } | { ok: false; reply: RouteReply };

/** Local mode: every request, launch and write passes; the body is still read under the default
 * cap, so a request's shape does not change with the mode (request-body.ts). */
export const UNLIMITED_ADMISSION: Admission = {
  limitsOf: () => undefined,
  async admitRequest(req) {
    const read = await readBodyUnderCap(req, DEFAULT_LIMITS.maxBodyBytes);
    return read.ok ? { ok: true, body: read.body } : { ok: false, reply: read.reply };
  },
  gateRefusal: () => undefined,
  runOwner: () => UNLIMITED,
  close: () => {},
};

export interface HostedAdmissionOptions {
  projectDir: string;
  limits: RequestLimits;
  creators: CreatorTable;
  /** The host database the VM time of every user is kept in. */
  hostDb: string;
  /** How long one VM may run, so a VM a previous process left open ends there at most. */
  maxVmMs: number;
  now?: () => number;
  freeDiskBytes?: () => number;
}

/** Hosted mode: the limits file, the request counters, VM time and storage, per user. */
export function hostedAdmission({
  projectDir,
  limits,
  creators,
  hostDb,
  maxVmMs,
  now = Date.now,
  freeDiskBytes,
}: HostedAdmissionOptions): Admission {
  const rate = createRateLimiter(now);
  const usage = openVmUsage(hostDb, now, maxVmMs);
  const run = createRunLimits({ projectDir, creators, usage, now, freeDiskBytes });

  return {
    limitsOf: (userId) => limits.forUser(userId),

    async admitRequest(req, userId): Promise<AdmissionResult> {
      const user = limits.forUser(userId);
      const taken = rate.take(userId, user.requestsPerMinute);
      if (!taken.ok) {
        return {
          ok: false,
          reply: {
            ...replyError(429, "too many requests: try again later"),
            headers: { "Retry-After": String(taken.retryAfterSeconds) },
          },
        };
      }
      const read = await readBodyUnderCap(req, user.maxBodyBytes);
      return read.ok ? { ok: true, body: read.body } : { ok: false, reply: read.reply };
    },

    gateRefusal(userId, gate) {
      const user = limits.forUser(userId);
      const refusal =
        gate === "launch" ? run.launchRefusal(userId, user) : run.storageRefusal(userId, user);
      return refusal === undefined ? undefined : refusalReply(refusal);
    },

    runOwner(userId) {
      const user = limits.forUser(userId);
      return {
        userId,
        maxRunningVms: user.maxRunningVms,
        startRefusal: () => run.launchRefusal(userId, user)?.message,
        meter: () => usage.begin(userId),
        importRefusal: () => run.storageRefusal(userId, user, true)?.message,
      };
    },

    close: () => usage.close(),
  };
}

function refusalReply({ status, message, retryAfterSeconds }: RunRefusal): RouteReply {
  return {
    ...replyError(status, message),
    headers:
      retryAfterSeconds === undefined ? undefined : { "Retry-After": String(retryAfterSeconds) },
  };
}
