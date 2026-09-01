import { createHash } from "node:crypto";

/**
 * The strong `ETag` both workflow-file doors issue: the sha256 of the exact on-disk bytes, hex,
 * double-quoted (server-api-v0.md §7.1). Defined once so the read door (`GET /v0/workflows/file`) and
 * the write door's precondition (`PUT /v0/workflows`) hash the **same byte source** — a `Buffer`, not a
 * re-decoded string. A round-trip through `toString("utf8")` would agree for valid-UTF-8 JSON but
 * differ on non-UTF-8 bytes, which would false-`412` a write against a file the read served cleanly.
 */
export function strongEtag(bytes: Buffer): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}
