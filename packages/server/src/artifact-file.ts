import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { strongEtag } from "./etag.js";

/**
 * One versioned JSON artifact file on disk as the write doors see it (server-api-v0.md §7, §10).
 *
 * The only way a door writes is {@link conditionalWrite} / {@link conditionalDelete} /
 * {@link removeArtifact}: each reads the current bytes, decides `If-Match` against their strong ETag,
 * and writes or removes — all inside one **synchronous** call. That matters because the check and the
 * write must have no suspension point between them: an `await` there turns the ETag compare-and-swap
 * into a TOCTOU race, and the caller cannot see the hazard in the types. Keeping the read private is
 * what makes it unmissable.
 */

/** The `412` wording per precondition conflict, at every artifact door; `required` arises only
 * under `overwrite`. */
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

/** What a door lets `If-Match` mean: `create-or-overwrite` — present overwrites a matching file,
 * absent creates (the workflow upsert and a template save-as); `overwrite` — required and must match
 * (template update, any delete). */
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
function checkPrecondition(
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

/** The bytes an artifact file holds for `raw`: `JSON.stringify(raw, null, 2)` + newline, the
 * client's key order kept. */
export function serializeArtifact(raw: unknown): string {
  return `${JSON.stringify(raw, null, 2)}\n`;
}

/** Serialize `raw` with {@link serializeArtifact} and write it. A create uses `wx`, so a file that raced into existence fails
 * `exists`. */
function writeArtifact(
  absPath: string,
  raw: unknown,
  opts: { create: boolean },
): { ok: true; etag: string } | { ok: false; conflict: "exists" } {
  const serialized = serializeArtifact(raw);
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

export interface ConditionalWrite {
  /** The `If-Match` the door received, verbatim. */
  ifMatch: string | undefined;
  rule: PreconditionRule;
  /** The parsed value to serialize; the door passes the **raw** request object so the author's key
   * order survives (ADR 0016). */
  payload: unknown;
}

export type ConditionalWriteResult =
  | { ok: true; etag: string; created: boolean }
  | { ok: false; conflict: ArtifactConflict };

/**
 * Read, decide and write in one call. `created` is the `201`-vs-`200` fact for a door that
 * distinguishes them; every refusal is the conflict the door maps to its own status.
 */
export function conditionalWrite(absPath: string, write: ConditionalWrite): ConditionalWriteResult {
  const precondition = checkPrecondition(readArtifact(absPath), write.ifMatch, write.rule);
  if (!precondition.ok) return precondition;
  const written = writeArtifact(absPath, write.payload, { create: precondition.create });
  if (!written.ok) return written;
  return { ok: true, etag: written.etag, created: precondition.create };
}

export type ConditionalDeleteResult = { ok: true } | { ok: false; conflict: ArtifactConflict };

/** Read, decide and remove in one call: `overwrite`'s rule, so an absent `If-Match` is `required`
 * and a file that is already gone is `missing` (its own `404`, not the `412` the other conflicts
 * take). */
export function conditionalDelete(
  absPath: string,
  ifMatch: string | undefined,
): ConditionalDeleteResult {
  const precondition = checkPrecondition(readArtifact(absPath), ifMatch, "overwrite");
  if (!precondition.ok) return precondition;
  rmSync(absPath);
  return { ok: true };
}

/** Remove one artifact file with no precondition: the door whose route resolves its target by
 * discovery and documents none (§10.5). It stays here so every artifact write has one owner. */
export function removeArtifact(absPath: string): void {
  rmSync(absPath);
}
