import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { instantiateWorkflow, type WorkflowFile } from "@path/schema";
import type { AuthoredLayout } from "./authored-layout.js";
import { confineToProjectRoot } from "./confine.js";

// Shipped workflows (ADR 0086): read-only starting points in the shipped workflow root. A user never
// runs one in place; Copy puts it in their own folder first.

export type ShippedCopy =
  | { ok: true; relativePath: string; rootPath: string }
  | { ok: false; status: 400 | 404; message: string };

/** A workflow file's bytes with fresh ids: two workflows must not share an identity (ADR 0006).
 * `suffix` is appended to the workflow's `name` when the copy took a numbered target. */
function freshCopy(bytes: Buffer, suffix: string): string {
  const file = instantiateWorkflow(JSON.parse(bytes.toString("utf8")) as WorkflowFile);
  return `${JSON.stringify({ ...file, name: `${file.name}${suffix}` }, null, 2)}\n`;
}

const WORKFLOW_SUFFIX = ".workflow.json";

/** `top` with `-<n>` before its `.workflow.json` suffix (a file) or at its end (a folder); `top`
 * itself for `n` 0. */
function numbered(top: string, n: number): string {
  if (n === 0) return top;
  return top.endsWith(WORKFLOW_SUFFIX)
    ? `${top.slice(0, -WORKFLOW_SUFFIX.length)}-${n}${WORKFLOW_SUFFIX}`
    : `${top}-${n}`;
}

/** Every file under `dir`, as absolute paths. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Copy the shipped workflow at `shippedPath` into the current user's workflow root. The copy unit is
 * the file's top-level folder, so the relative refs inside it still resolve; a file directly under
 * the shipped root has no refs and is copied alone. Every workflow file gets fresh ids
 * (`instantiateWorkflow`); other files are copied verbatim. An existing target is not overwritten:
 * the copy takes the first free `<top>-<n>`, and the chosen workflow's `name` gets the same `-<n>`.
 * All or nothing: the copy is staged in a dot-folder discovery skips, then renamed into place.
 */
export function copyShippedWorkflow(layout: AuthoredLayout, shippedPath: string): ShippedCopy {
  const shippedDir = layout.root("shipped", "workflow").dir;
  const source = confineToProjectRoot(shippedDir, shippedPath);
  if (source === undefined || !source.endsWith(WORKFLOW_SUFFIX)) {
    return { ok: false, status: 404, message: "not a shipped workflow" };
  }

  const segments = relative(shippedDir, source).split(sep);
  const [top = ""] = segments;
  const userRoot = layout.root("user", "workflow").dir;
  let n = 0;
  while (existsSync(join(userRoot, numbered(top, n)))) n += 1;
  const targetTop = numbered(top, n);
  const suffix = n === 0 ? "" : `-${n}`;

  // Every file's content is decided before the first write, so a bad file leaves nothing behind.
  const files = segments.length === 1 ? [source] : filesUnder(join(shippedDir, top));
  let contents: { path: string; content: string | Buffer }[];
  try {
    contents = files.map((file) => {
      const bytes = readFileSync(file);
      const content = file.endsWith(WORKFLOW_SUFFIX)
        ? freshCopy(bytes, file === source ? suffix : "")
        : bytes;
      return { path: relative(shippedDir, file), content };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 400, message: `shipped workflow cannot be copied: ${reason}` };
  }

  mkdirSync(userRoot, { recursive: true });
  const stage = mkdtempSync(join(userRoot, ".copy-"));
  try {
    for (const { path, content } of contents) {
      const destination = join(stage, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content, { flag: "wx" });
    }
    renameSync(join(stage, top), join(userRoot, targetTop));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const copied = join(userRoot, targetTop, ...segments.slice(1));
  return {
    ok: true,
    relativePath: relative(layout.projectDir, copied),
    rootPath: relative(userRoot, copied),
  };
}
