import { resolve } from "node:path";

/**
 * Resolve a worker's own relative path against the workflow file's directory (`request.cwd`), never `process.cwd()`
 * (ADR 0019 sub-8): anchoring to the launching shell would make a workflow's behaviour caller-dependent.
 */
export function resolveAgainstWorkflowDir(cwd: string, relative: string): string {
  return resolve(cwd, relative);
}
