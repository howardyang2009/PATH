/**
 * Resolve a `workflow`-ref's relative path against the file that holds it, so a descent crosses to the
 * right file (designer-spec § The model: inline within a file, drill-down across a ref boundary). A
 * `ref` is a relative path (`node-type.ts`, workflow-format §4.2), resolved from the referring file's
 * **directory** — POSIX-style, browser-safe (no `node:path`). `.` and empty segments drop; `..` pops one
 * segment. The server still confines the resolved path to the project root; this only forms the query.
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

/** The last path segment — the file name — for a breadcrumb label when a file did not open with a `name`. */
export function basename(path: string): string {
  const segments = path.split("/").filter((s) => s !== "");
  return segments.length > 0 ? segments[segments.length - 1]! : path;
}

/**
 * The inverse of `resolveRefPath` (#391): the relative `ref` a file at `fromPath` must store to reach the
 * project-relative `toPath`, so a create-new nested ref can set the parent's ref from two absolute paths.
 * Resolved from the referring file's **directory**, POSIX-style: it emits one `..` per directory the
 * parent must climb out of, then the remainder of the target. It satisfies
 * `resolveRefPath(fromPath, relativeRefPath(fromPath, toPath)) === toPath`, so a descent across the
 * stored ref lands back on `toPath`.
 */
export function relativeRefPath(fromPath: string, toPath: string): string {
  const fromDir = fromPath.split("/").filter((s) => s !== "").slice(0, -1);
  const to = toPath.split("/").filter((s) => s !== "");
  let common = 0;
  while (common < fromDir.length && common < to.length && fromDir[common] === to[common]) common++;
  const ups = Array<string>(fromDir.length - common).fill("..");
  const downs = to.slice(common);
  const parts = [...ups, ...downs];
  // A target in the parent's own directory has no `..` and one segment — never an empty ref.
  return parts.length > 0 ? parts.join("/") : basename(toPath);
}
