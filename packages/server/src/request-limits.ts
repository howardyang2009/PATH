import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatIssues } from "@path/schema";
import { z } from "zod";
import type { AuthoredRefusal } from "./authored-layout.js";
import type { CreatorTable } from "./creator-table.js";

// Request and run limits: what one hosted user may do through the API and in VMs. The defaults
// hold for everyone; `.path/limits.json` overrides any of them per user id.

const LimitSchema = z.number().int().nonnegative();
const UserLimitsSchema = z
  .object({
    requestsPerMinute: LimitSchema,
    maxBodyBytes: LimitSchema,
    maxSharedItems: LimitSchema,
    maxFileBytes: LimitSchema,
    maxRunningVms: LimitSchema,
    vmSecondsPerDay: LimitSchema,
    maxStorageBytes: LimitSchema,
  })
  .strict();
const LimitsFileSchema = z
  .object({ users: z.record(z.string(), UserLimitsSchema.partial()).optional() })
  .strict();

/** One user's limits. A limit of 0 refuses every request, shared item, file or launch it bounds. */
export type UserLimits = z.infer<typeof UserLimitsSchema>;

export const DEFAULT_LIMITS: UserLimits = {
  requestsPerMinute: 120,
  maxBodyBytes: 1024 * 1024,
  maxSharedItems: 50,
  maxFileBytes: 1024 * 1024,
  maxRunningVms: 1,
  vmSecondsPerDay: 2 * 60 * 60,
  maxStorageBytes: 1024 * 1024 * 1024,
};

export interface RequestLimits {
  forUser(userId: string): UserLimits;
}

/** The limits of a project: the defaults, plus the overrides in `.path/limits.json` when it exists.
 * A malformed file throws, so the Server refuses to start. */
export function readRequestLimits(projectDir: string): RequestLimits {
  const path = join(projectDir, ".path", "limits.json");
  const users = new Map<string, UserLimits>();
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`${path} is not valid JSON. Refusing to start`);
    }
    const parsed = LimitsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${path} is invalid: ${formatIssues(parsed.error).join("; ")}`);
    }
    for (const [userId, overrides] of Object.entries(parsed.data.users ?? {})) {
      users.set(userId, { ...DEFAULT_LIMITS, ...overrides });
    }
  }
  return { forUser: (userId) => users.get(userId) ?? DEFAULT_LIMITS };
}

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  /** Count one request of `userId` against `perMinute`. */
  take(userId: string, perMinute: number): RateDecision;
}

const WINDOW_MS = 60_000;

/** Per-user request counters in memory over a sliding minute: each user keeps the times of their
 * requests in the last minute, and a user with none is dropped at the next sweep. */
export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const recent = new Map<string, number[]>();
  let lastSweep = now();

  const expire = (times: number[], t: number): void => {
    while (times.length > 0 && t - (times[0] as number) >= WINDOW_MS) times.shift();
  };

  return {
    take(userId, perMinute) {
      const t = now();
      if (t - lastSweep >= WINDOW_MS) {
        for (const [id, times] of recent) {
          expire(times, t);
          if (times.length === 0) recent.delete(id);
        }
        lastSweep = t;
      }
      const times = recent.get(userId) ?? [];
      expire(times, t);
      if (times.length >= perMinute) {
        // The slot frees when the request `perMinute` back leaves the window.
        const freedAt = (times[times.length - perMinute] ?? t) + WINDOW_MS;
        return { ok: false, retryAfterSeconds: Math.ceil((freedAt - t) / 1000) };
      }
      times.push(t);
      recent.set(userId, times);
      return { ok: true };
    },
  };
}

/** A byte count as the MB a refusal message shows. */
export function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/** The `403` for a user who may create no more shared items. */
export function sharedItemLimitRefusal(
  limits: UserLimits | undefined,
  creators: CreatorTable,
  userId: string,
): AuthoredRefusal | undefined {
  if (limits === undefined || creators.countBy(userId) < limits.maxSharedItems) return undefined;
  return {
    status: 403,
    message: `shared item limit reached (${limits.maxSharedItems}): delete a shared item first`,
  };
}

/** The `403` for an authored file of `bytes` over the user's file size. */
export function fileSizeRefusal(
  limits: UserLimits | undefined,
  bytes: number,
): AuthoredRefusal | undefined {
  if (limits === undefined || bytes <= limits.maxFileBytes) return undefined;
  return {
    status: 403,
    message: `file too large: an authored file may be at most ${megabytes(limits.maxFileBytes)}`,
  };
}
