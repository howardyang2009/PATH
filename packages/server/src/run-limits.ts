import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import type { CreatorTable } from "./creator-table.js";
import type { UserLimits } from "./request-limits.js";
import type { VmUsage } from "./vm-usage.js";

// Run limits (docs/spec/path-website.md §8): the VM time and storage one hosted user may use, and
// the free disk the host keeps. Running VMs per user are held by the VM slots.

export const MIN_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024;
export const STORAGE_FULL = "storage full, delete runs";

/** How long a measured storage size under the user's limit is reused. */
const STORAGE_CACHE_MS = 30_000;

/** A run limit's refusal: the status and message the user sees. */
export interface RunRefusal {
  status: 429 | 507;
  message: string;
  retryAfterSeconds?: number;
}

export interface RunLimits {
  /** Why `userId` may not launch a VM (Start, Resume or Complete) now, or `undefined`. */
  launchRefusal(userId: string, limits: UserLimits): RunRefusal | undefined;
  /** Why `userId` may not write an authored file or import a VM's rows now, or `undefined`. A
   * write may reuse a recent size; an import measures again. */
  storageRefusal(userId: string, limits: UserLimits, fresh?: boolean): RunRefusal | undefined;
}

export interface RunLimitsOptions {
  projectDir: string;
  creators: CreatorTable;
  usage: VmUsage;
  freeDiskBytes?: () => number;
  now?: () => number;
}

export function createRunLimits({
  projectDir,
  creators,
  usage,
  freeDiskBytes = () => {
    const stats = statfsSync(projectDir);
    return stats.bavail * stats.bsize;
  },
  now = Date.now,
}: RunLimitsOptions): RunLimits {
  const measured = new Map<string, { bytes: number; at: number }>();

  /** The user's store, runs, blobs and own authored files under `users/<id>/`, and the shared
   * items they created. A write reuses a size under the limit for a while; a launch, a VM import
   * and a size over the limit measure again, so a run's blobs or a delete count at once. */
  const storageBytes = (userId: string, limit: number, fresh = false): number => {
    const held = measured.get(userId);
    if (!fresh && held && held.bytes <= limit && now() - held.at < STORAGE_CACHE_MS) {
      return held.bytes;
    }
    let bytes = diskBytes(join(projectDir, "users", userId));
    for (const path of creators.pathsBy(userId)) bytes += diskBytes(join(projectDir, path));
    measured.set(userId, { bytes, at: now() });
    return bytes;
  };

  const storageRefusal = (
    userId: string,
    limits: UserLimits,
    fresh = false,
  ): RunRefusal | undefined =>
    limits.maxStorageBytes === 0 ||
    storageBytes(userId, limits.maxStorageBytes, fresh) > limits.maxStorageBytes
      ? { status: 507, message: STORAGE_FULL }
      : undefined;

  return {
    launchRefusal(userId, limits) {
      if (freeDiskBytes() < MIN_FREE_DISK_BYTES) {
        return { status: 507, message: "the host is low on disk: launches are paused, try later" };
      }
      const full = storageRefusal(userId, limits, true);
      if (full !== undefined) return full;
      if (limits.maxRunningVms === 0) {
        return { status: 429, message: "launches are off for this user" };
      }
      const retryAt = usage.retryAt(userId, limits.vmSecondsPerDay * 1000);
      if (retryAt === undefined) return undefined;
      if (retryAt === Number.POSITIVE_INFINITY) {
        return { status: 429, message: "budget used: this user has no VM time" };
      }
      return {
        status: 429,
        message: `budget used, try at ${new Date(retryAt).toISOString()}`,
        retryAfterSeconds: Math.ceil((retryAt - now()) / 1000),
      };
    },
    storageRefusal,
  };
}

/** The bytes of the regular files at or under `path`; symlinks are not followed, and a file that
 * goes away mid-walk counts 0. */
function diskBytes(path: string): number {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  return entries.reduce((bytes, entry) => bytes + diskBytes(join(path, entry)), 0);
}
