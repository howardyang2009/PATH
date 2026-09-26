import { createHash } from "node:crypto";

/**
 * Strong `ETag` = quoted hex sha256 of the exact on-disk bytes (server-api-v0.md §7.1); hash the `Buffer`, not a
 * re-decoded string, or non-UTF-8 bytes false-412.
 */
export function strongEtag(bytes: Buffer): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}
