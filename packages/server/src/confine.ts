import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Resolve `relPath` to an absolute path *inside* `projectDir`, or `undefined` when it must not be
 * touched. This is the read/write door's confinement (server-api-v0.md §7, §7.1), stricter than
 * discovery's list-time skip, and the *one* place it is spelled (ADR 0016: the write reuses the read's
 * escape/confine logic verbatim, not a second copy):
 *
 * - Lexical `resolve` against the fixed root, then a `relative` check — a path that escapes the root
 *   (`..`, or an absolute path) yields `undefined`, the same stance `prepareWorkflow` takes.
 *   `relFromRoot === ""` (the root itself) is refused — it is a directory, not a file.
 * - A per-**component** `lstat`: if any segment is a symlink, `undefined`. A symlinked parent directory
 *   could otherwise redirect the access outside the root even when the lexical path stays inside, so
 *   the refusal is to *traverse* a symlink, not merely to list one.
 *
 * `allowMissingTail` is the one difference between the two doors. A **read** (`GET /v0/workflows/file`)
 * requires every component to exist, so a component whose `lstat` throws is `undefined` — folded into
 * the same 404 as an escape. A **write** (`PUT /v0/workflows`) may *create* a file (and its parent
 * dirs), so a component that does not exist yet stops the walk instead: nothing deeper can exist, so
 * there is no further symlink to redirect the write, and the parent chain up to here was real and
 * symlink-free. A leaf that already exists as a symlink is still refused in both modes.
 */
export function confineToProjectRoot(
  projectDir: string,
  relPath: string,
  { allowMissingTail = false }: { allowMissingTail?: boolean } = {},
): string | undefined {
  const absPath = resolve(projectDir, relPath);
  const relFromRoot = relative(projectDir, absPath);
  if (relFromRoot === "" || relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) return undefined;

  let current = projectDir;
  for (const segment of relFromRoot.split(sep)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return undefined;
    } catch {
      if (allowMissingTail) break;
      return undefined;
    }
  }
  return absPath;
}
