/**
 * Resolve a ref's relative path from the referring file's **directory**, POSIX-style (no `node:path`); the server
 * confines the result to the project root.
 */
export function resolveRefPath(fromPath: string, ref: string): string {
  const fromDir = fromPath.split("/").slice(0, -1);
  const out: string[] = [];
  for (const segment of [...fromDir, ...ref.split("/")]) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

export function basename(path: string): string {
  const segments = path.split("/").filter((s) => s !== "");
  return segments.length > 0 ? segments[segments.length - 1]! : path;
}

/**
 * The inverse of `resolveRefPath`: the relative `ref` a file at `fromPath` must store to reach the
 * project-relative `toPath`; satisfies `resolveRefPath(fromPath, relativeRefPath(fromPath, toPath)) === toPath`.
 */
export function relativeRefPath(fromPath: string, toPath: string): string {
  const fromDir = fromPath
    .split("/")
    .filter((s) => s !== "")
    .slice(0, -1);
  const to = toPath.split("/").filter((s) => s !== "");
  let common = 0;
  while (common < fromDir.length && common < to.length && fromDir[common] === to[common]) common++;
  const ups = Array<string>(fromDir.length - common).fill("..");
  const downs = to.slice(common);
  const parts = [...ups, ...downs];
  // A target in the parent's own directory has no `..` and one segment — never an empty ref.
  return parts.length > 0 ? parts.join("/") : basename(toPath);
}
