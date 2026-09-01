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
