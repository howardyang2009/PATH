import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { strongEtag } from "./etag.js";

/**
 * One **versioned JSON artifact file** on disk — a workflow file or a template — as the write doors
 * see it (server-api-v0.md §7, §10, ADR 0016/0050). Every write door reads the current bytes, checks
 * an `If-Match` precondition against their strong ETag, serializes the client's raw object with its
 * key order preserved, and writes create-only (`wx`) or overwrite. Each route used to inline that; this
 * owns it once, and a route is an adapter that maps a {@link ArtifactConflict} to its own status and
 * wording.
 *
 * Concurrency stance (ADR 0016): read, check and write are synchronous, so a route that runs them in
 * one block with no `await` between leaves only an *external* writer to guard, which the ETag detects.
 */

/**
 * The `412` wording for each precondition conflict, at every artifact door — workflow write and
 * delete, template update (ADR 0016/0050). `required` arises only under the `overwrite` rule, where an
 * `If-Match` must be sent.
 */
export const PRECONDITION_FAILED: Record<ArtifactConflict, string> = {
  missing: "precondition failed: the file no longer exists",
  changed: "precondition failed: the file changed since it was read",
  exists: "precondition failed: the file already exists (send If-Match to overwrite)",
  required: "precondition failed: send If-Match with the ETag you last read",
};

/** Why a precondition or a create failed. */
export type ArtifactConflict =
  /** `If-Match` sent, but the file is gone. */
  | "missing"
  /** `If-Match` sent, but the bytes changed since it was read. */
  | "changed"
  /** A create found the file already there. */
  | "exists"
  /** An overwrite or delete sent no `If-Match`. */
  | "required";

/**
 * What a door lets `If-Match` mean:
 *
 * - `create-or-overwrite` — present overwrites a matching file; absent creates (the workflow upsert).
 * - `overwrite` — required, and must match (template update, any delete).
 */
export type PreconditionRule = "create-or-overwrite" | "overwrite";

/** The current bytes of an artifact file, or `undefined` when it does not exist. */
export function readArtifact(absPath: string): Buffer | undefined {
  try {
    return readFileSync(absPath);
  } catch {
    return undefined;
  }
}

/**
 * Check `ifMatch` against `current` under `rule`. There is no `If-Match: *` wildcard: no header spells
 * a blind last-writer-wins overwrite, so `*` fails the exact match like any stale value.
 */
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

/**
 * Serialize `raw` deterministically (`JSON.stringify(raw, null, 2)` + newline, the client's key order
 * kept) and write it. A create uses `wx`, so a file that raced into existence fails `exists` rather
 * than being clobbered; intermediate directories are created. Returns the new bytes' strong ETag.
 */
export function writeArtifact(absPath: string, raw: unknown, opts: { create: false }): { ok: true; etag: string };
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
    if (opts.create && (err as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, conflict: "exists" };
    throw err;
  }
  return { ok: true, etag: strongEtag(Buffer.from(serialized, "utf8")) };
}

/** Remove an artifact file whose precondition already passed. */
export function deleteArtifact(absPath: string): void {
  rmSync(absPath);
}
