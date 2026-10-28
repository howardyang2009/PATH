import { existsSync } from "node:fs";
import { type LoadResult, loadWorkflowTree } from "@path/engine";
import { readArtifact } from "./artifact-file.js";
import type { AuthoredLayout } from "./authored-layout.js";
import { confineToProjectRoot } from "./confine.js";
import { strongEtag } from "./etag.js";

/**
 * The one read seam for an authored workflow handle: every door that reads a workflow by its
 * project-relative path resolves the handle here — in the requester's view, confined to the
 * project (no symlink, no escape), and read from disk. A door keeps its own policy (a shipped file
 * cannot run, a bundle walks its refs); it no longer re-derives those three rules.
 */

/** Why a handle names no readable file. Doors map these to their own 404 wording. */
export type AuthoredMiss = "outside-view" | "escapes-root" | "missing";

/** A handle resolved to readable bytes, with the strong ETag a conditional read hands back. */
export interface AuthoredFile {
  absPath: string;
  bytes: Buffer;
  etag: string;
}

export type AuthoredRead = { ok: true; file: AuthoredFile } | { ok: false; miss: AuthoredMiss };

/** A read of `handle`: confined, then read; a door never learns an escape from a miss. */
export function locateAuthoredFile(layout: AuthoredLayout, handle: string): AuthoredRead {
  // Another user's path reads as missing, so a refusal never confirms that it exists (ADR 0088).
  if (handle === "" || !layout.inView(handle)) return { ok: false, miss: "outside-view" };
  // A missing tail is not an escape: the confine walk stops at the first absent component, so the
  // file's absence reads as a 404 rather than a refusal.
  const absPath = confineToProjectRoot(layout.projectDir, handle, { allowMissingTail: true });
  if (absPath === undefined) return { ok: false, miss: "escapes-root" };
  if (!existsSync(absPath)) return { ok: false, miss: "missing" };
  const bytes = readArtifact(absPath);
  if (bytes === undefined) return { ok: false, miss: "missing" };
  return { ok: true, file: { absPath, bytes, etag: strongEtag(bytes) } };
}

/** Load and validate the workflow at a confined authored path, with `ref`s held to the same view. */
export function loadAuthoredWorkflow(layout: AuthoredLayout, absPath: string): Promise<LoadResult> {
  return loadWorkflowTree(absPath, { refAllowed: layout.inView });
}
