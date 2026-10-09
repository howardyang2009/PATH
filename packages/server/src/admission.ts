import type { IncomingMessage } from "node:http";
import type { CreatorTable } from "./creator-table.js";
import { bufferRequestBody, type RouteReply, replyError } from "./http-json.js";
import {
  createRateLimiter,
  megabytes,
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
  /** Counts one request of `userId` and reads its body under their cap: the `429` or `413` past
   * either. A GET is counted and its body left unread. */
  admitRequest(req: IncomingMessage, userId: string): Promise<RouteReply | undefined>;
  /** The refusal of `gate` for `userId` now, with its `Retry-After` when it has one. */
  gateRefusal(userId: string, gate: AdmissionGate): RouteReply | undefined;
  /** What the VMs `userId` launches are held to. */
  runOwner(userId: string): RunOwner;
  close(): void;
}

/** Local mode: every request, launch and write passes. */
export const UNLIMITED_ADMISSION: Admission = {
  limitsOf: () => undefined,
  admitRequest: async () => undefined,
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

    async admitRequest(req, userId): Promise<RouteReply | undefined> {
      const user = limits.forUser(userId);
      const taken = rate.take(userId, user.requestsPerMinute);
      if (!taken.ok) {
        return {
          ...replyError(429, "too many requests: try again later"),
          headers: { "Retry-After": String(taken.retryAfterSeconds) },
        };
      }
      if (req.method === "GET") return undefined;
      const body = await bufferRequestBody(req, user.maxBodyBytes);
      if (body.ok) return undefined;
      return {
        ...replyError(413, `request body too large: at most ${megabytes(user.maxBodyBytes)}`),
        headers: body.close ? { Connection: "close" } : undefined,
      };
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
