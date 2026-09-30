import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateWorkflow, type WorkflowFile } from "@path/schema";
import { authoredRoot } from "./authored-roots.js";
import { confineToProjectRoot } from "./confine.js";

// Shipped workflows (ADR 0086): read-only starting points under `packages/server/shipped/workflow/`.
// A user never runs one in place; Copy puts it in their own folder first.

/** The shipped (read-only) workflow root. A caller (a test) may inject a different root. */
export const DEFAULT_SHIPPED_WORKFLOW_DIR = fileURLToPath(
  new URL("../shipped/workflow", import.meta.url),
);

/** The shipped root discovery and Copy read: the context override, or the package default. */
export function shippedWorkflowDir(ctx: { shippedWorkflowDir?: string }): string {
  return ctx.shippedWorkflowDir ?? DEFAULT_SHIPPED_WORKFLOW_DIR;
}

export type ShippedCopy =
  | { ok: true; relativePath: string }
  | { ok: false; status: 404 | 409; message: string };

/** A workflow file's bytes with fresh ids: two workflows must not share an identity (ADR 0006). */
function freshCopy(bytes: Buffer): string {
  const file = JSON.parse(bytes.toString("utf8")) as WorkflowFile;
  return `${JSON.stringify(instantiateWorkflow(file), null, 2)}\n`;
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
 * (`instantiateWorkflow`); other files are copied verbatim. An existing target is the `409`.
 */
export function copyShippedWorkflow(
  projectDir: string,
  shippedDir: string,
  shippedPath: string,
): ShippedCopy {
  const source = confineToProjectRoot(shippedDir, shippedPath);
  if (source === undefined || !source.endsWith(".workflow.json")) {
    return { ok: false, status: 404, message: "not a shipped workflow" };
  }

  const segments = relative(shippedDir, source).split(sep);
  const [top = ""] = segments;
  const userRoot = authoredRoot(projectDir, "user", "workflow");
  const target = join(userRoot, top);
  if (existsSync(target)) {
    return {
      ok: false,
      status: 409,
      message: `"${relative(projectDir, target)}" already exists`,
    };
  }

  const files = segments.length === 1 ? [source] : filesUnder(join(shippedDir, top));
  for (const file of files) {
    const destination = join(userRoot, relative(shippedDir, file));
    const bytes = readFileSync(file);
    const content = file.endsWith(".workflow.json") ? freshCopy(bytes) : bytes;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { flag: "wx" });
  }
  return { ok: true, relativePath: relative(projectDir, join(userRoot, ...segments)) };
}
