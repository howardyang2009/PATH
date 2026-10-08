import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatIssues } from "@path/schema";
import { z } from "zod";
import type { AuthoredRefusal } from "./authored-layout.js";
import type { CreatorTable } from "./creator-table.js";

// Request limits (docs/spec/path-website.md §8): what one hosted user may do through the API. The
// defaults hold for everyone; `.path/limits.json` overrides any of them per user id.

export const MIB = 1024 * 1024;

/** One user's limits. A limit of 0 refuses every request, shared item or file it bounds. */
export interface UserLimits {
  requestsPerMinute: number;
  maxBodyBytes: number;
  maxSharedItems: number;
  maxFileBytes: number;
}

export const DEFAULT_LIMITS: UserLimits = {
  requestsPerMinute: 120,
  maxBodyBytes: MIB,
  maxSharedItems: 50,
  maxFileBytes: MIB,
};

const LimitSchema = z.number().int().nonnegative();
const OverridesSchema = z
  .object({
    requests_per_minute: LimitSchema.optional(),
    max_body_bytes: LimitSchema.optional(),
    max_shared_items: LimitSchema.optional(),
    max_file_bytes: LimitSchema.optional(),
  })
  .strict();
const LimitsFileSchema = z
  .object({ users: z.record(z.string(), OverridesSchema).optional() })
  .strict();

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
    for (const [userId, o] of Object.entries(parsed.data.users ?? {})) {
      users.set(userId, {
        requestsPerMinute: o.requests_per_minute ?? DEFAULT_LIMITS.requestsPerMinute,
        maxBodyBytes: o.max_body_bytes ?? DEFAULT_LIMITS.maxBodyBytes,
        maxSharedItems: o.max_shared_items ?? DEFAULT_LIMITS.maxSharedItems,
        maxFileBytes: o.max_file_bytes ?? DEFAULT_LIMITS.maxFileBytes,
      });
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

/** Per-user request counters in memory: a window opens at a user's first request and lasts one
 * minute. */
export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    take(userId, perMinute) {
      const t = now();
      let window = windows.get(userId);
      if (window === undefined || t - window.start >= WINDOW_MS) {
        window = { start: t, count: 0 };
        windows.set(userId, window);
      }
      if (window.count >= perMinute) {
        return { ok: false, retryAfterSeconds: Math.ceil((window.start + WINDOW_MS - t) / 1000) };
      }
      window.count++;
      return { ok: true };
    },
  };
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / MIB) * 10) / 10} MB`;
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
