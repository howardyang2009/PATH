import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { strongEtag } from "./etag.js";

/** One versioned JSON artifact file on disk as the write doors see it (server-api-v0.md §7, §10): read,
 * check `If-Match` against the strong ETag, then write create-only (`wx`) or overwrite — synchronously. */

/** The `412` wording per precondition conflict, at every artifact door; `required` arises only under `overwrite`. */
export const PRECONDITION_FAILED: Record<ArtifactConflict, string> = {
  missing: "precondition failed: the file no longer exists",
  changed: "precondition failed: the file changed since it was read",
  exists: "precondition failed: the file already exists (send If-Match to overwrite)",
  required: "precondition failed: send If-Match with the ETag you last read",
};

/** Why a precondition or a create failed. */
export type ArtifactConflict =
  | "missing"
  | "changed"
  | "exists"
  /** An overwrite or delete sent no `If-Match`. */
  | "required";

/** What a door lets `If-Match` mean: `create-or-overwrite` — present overwrites a matching file, absent
 * creates (the workflow upsert); `overwrite` — required and must match (template update, any delete). */
export type PreconditionRule = "create-or-overwrite" | "overwrite";

/** The current bytes of an artifact file, or `undefined` when it does not exist. */
export function readArtifact(absPath: string): Buffer | undefined {
  try {
    return readFileSync(absPath);
  } catch {
    return undefined;
  }
}

/** Check `ifMatch` against `current`. No `If-Match: *` wildcard: `*` fails the exact match like any
 * stale value, since no header spells a blind last-writer-wins overwrite. */
export function checkPrecondition(
  current: Buffer | undefined,
  ifMatch: string | undefined,
  rule: PreconditionRule,
): { ok: true; create: boolean } | { ok: false; conflict: ArtifactConflict } {
  if (ifMatch === undefined) {
    if (rule === "overwrite") return { ok: false, conflict: "required" };
    return current === undefined ? { ok: true, create: true } : { ok: false, conflict: "exists" };
  }
  if (current === undefined) return { ok: false, conflict: "missing" };
  if (ifMatch !== strongEtag(current)) return { ok: false, conflict: "changed" };
  return { ok: true, create: false };
}

/** Serialize `raw` deterministically (`JSON.stringify(raw, null, 2)` + newline, the client's key order
 * kept) and write it. A create uses `wx`, so a file that raced into existence fails `exists`. */
export function writeArtifact(
  absPath: string,
  raw: unknown,
  opts: { create: false },
): { ok: true; etag: string };
export function writeArtifact(
  absPath: string,
  raw: unknown,
  opts: { create: boolean },
): { ok: true; etag: string } | { ok: false; conflict: "exists" };
export function writeArtifact(
  absPath: string,
  raw: unknown,
  opts: { create: boolean },
): { ok: true; etag: string } | { ok: false; conflict: "exists" } {
  const serialized = `${JSON.stringify(raw, null, 2)}\n`;
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, serialized, opts.create ? { flag: "wx" } : undefined);
  } catch (err) {
    if (opts.create && (err as NodeJS.ErrnoException).code === "EEXIST")
      return { ok: false, conflict: "exists" };
    throw err;
  }
  return { ok: true, etag: strongEtag(Buffer.from(serialized, "utf8")) };
}

/** Remove an artifact file whose precondition already passed. */
export function deleteArtifact(absPath: string): void {
  rmSync(absPath);
}
