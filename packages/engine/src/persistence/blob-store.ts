import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@path/schema";
import { blobRef, runBlobDir } from "./paths.js";

/**
 * Write-temp-then-rename: a same-filesystem rename is atomic, so a reader (or a crash) never
 * observes a partially written blob — this is what makes `context.json`'s write-through
 * (mvp spec §6) a truthful snapshot even if the engine is killed mid-write.
 */
export function writeBlobFile(dir: string, filename: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, filename);
  const tmpPath = join(dir, `.${filename}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, finalPath);
}

export function writeJsonBlob(dir: string, filename: string, value: JsonValue): void {
  writeBlobFile(dir, filename, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonBlob(dir: string, filename: string): JsonValue {
  return JSON.parse(readFileSync(join(dir, filename), "utf8")) as JsonValue;
}

export function dirExists(dir: string): boolean {
  return existsSync(dir);
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Writes one of a run's blobs and returns the ref that addresses it — **one call producing both**,
 * which is the point (#72).
 *
 * Where the bytes go (`runBlobDir`, host separators) and what the row records (`blobRef`, always
 * forward slashes) are two values that must address the same file. They were built separately at
 * each call site, so a mismatch put the blob on disk with a row pointing elsewhere: no error, no
 * failing test, just a run whose input is unreadable through the API. Derived from one set of
 * arguments here, they cannot disagree.
 */
export function writeRunBlob(
  projectDir: string,
  rootRunId: string,
  runId: string,
  filename: string,
  value: JsonValue,
): string {
  writeJsonBlob(runBlobDir(projectDir, rootRunId, runId), filename, value);
  return blobRef(rootRunId, runId, filename);
}
