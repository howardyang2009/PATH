import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Resolve `relPath` to an absolute path inside `projectDir`, or `undefined` when it must not be touched:
 * a lexical escape, the root itself, or any component that is a symlink (could redirect outside the
 * root). `allowMissingTail` (write doors) stops at the first missing component; a read requires all.
 */
export function confineToProjectRoot(
  projectDir: string,
  relPath: string,
  { allowMissingTail = false }: { allowMissingTail?: boolean } = {},
): string | undefined {
  const absPath = resolve(projectDir, relPath);
  const relFromRoot = relative(projectDir, absPath);
  if (relFromRoot === "" || relFromRoot.startsWith("..") || isAbsolute(relFromRoot))
    return undefined;

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
