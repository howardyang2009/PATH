import { resolve } from "node:path";

/**
 * Resolve a worker's own relative path against the workflow file's directory — the anchor PATH uses
 * everywhere, never `process.cwd()` (#313 sub-14, ADR 0019 sub-8). A worker receives that directory as
 * `request.cwd` and passes it here; `binary`'s `spawn` is the first consumer, resolving its `cwd` field
 * (ADR 0021 sub-6). Anchoring to the shell that launched `path run` would make a workflow's behaviour
 * depend on the caller's directory, and make `"cwd": "."` differ from omitting `cwd` (format doc §4.2).
 *
 * It is `path.resolve`'s two-argument form, named for the one rule it enforces: an absolute `relative`
 * wins (as `resolve` already does), and an empty or `"."` `relative` yields `cwd` itself.
 */
export function resolveAgainstWorkflowDir(cwd: string, relative: string): string {
  return resolve(cwd, relative);
}
