import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type WorkflowNode, walkNodes } from "@path/schema";
import { zipSync } from "fflate";
import { readArtifact } from "./artifact-file.js";
import { AUTHORED_SUFFIX, type AuthoredLayout, type AuthoredRoot } from "./authored-layout.js";
import { confineToProjectRoot } from "./confine.js";

/** One `ref` the closure walk could not follow: as written, in which file, and why. */
export interface BundleFailure {
  ref: string;
  from: string;
  reason: string;
}

export type WorkflowBundle =
  | { ok: true; contentType: "application/json"; fileName: string; bytes: Buffer }
  | { ok: true; contentType: "application/zip"; fileName: string; bytes: Uint8Array }
  | { ok: false; status: 404 }
  | { ok: false; status: 422; failures: BundleFailure[] };

const SUFFIX = AUTHORED_SUFFIX.workflow;

// Local-time fields, so the DOS date is the same in every time zone.
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);

function rootOf(roots: readonly AuthoredRoot[], absPath: string): AuthoredRoot | undefined {
  return roots.find((root) => {
    const rel = relative(root.dir, absPath);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/** The `ref` of every `workflow` step, found in a file that may not be schema-valid. */
function refsOf(raw: unknown): string[] {
  const body = (raw as { body?: unknown } | null)?.body;
  if (!Array.isArray(body)) return [];
  const refs: string[] = [];
  try {
    for (const node of walkNodes(body as WorkflowNode[])) {
      if (node.type === "workflow" && typeof node.ref === "string") refs.push(node.ref);
    }
  } catch {
    // A malformed body yields the refs found before it broke; the file still goes in as is.
  }
  return refs;
}

/**
 * The download of the workflow at `handle`: its file as saved, or a zip of every file its `ref`s
 * reach (a visited set, so a cycle is no error). The zip holds a virtual project layout under one
 * folder, so each relative `ref` resolves after unzip with no rewriting. `shipped` makes `handle` a
 * path in the shipped root; otherwise it is a project path under a writable workflow root.
 */
export function bundleWorkflow(
  layout: AuthoredLayout,
  handle: string,
  shipped: boolean,
): WorkflowBundle {
  const roots = layout.roots("workflow");
  const base = shipped ? layout.root("shipped", "workflow").dir : layout.projectDir;
  const rootPath = confineToProjectRoot(base, handle);
  const rootRoot = rootPath === undefined ? undefined : rootOf(roots, rootPath);
  if (rootPath === undefined || rootRoot === undefined || rootRoot.writable === shipped) {
    return { ok: false, status: 404 };
  }
  if (!rootPath.endsWith(SUFFIX)) return { ok: false, status: 404 };

  const entryOf = (absPath: string, root: AuthoredRoot): string => {
    const rel = root.writable
      ? relative(layout.projectDir, absPath)
      : join("shipped", "workflow", relative(root.dir, absPath));
    return rel.split(sep).join("/");
  };

  const rootBytes = readArtifact(rootPath);
  if (rootBytes === undefined) return { ok: false, status: 404 };

  const files = new Map<string, { bytes: Buffer; entry: string }>();
  const failures: BundleFailure[] = [];

  const visit = (absPath: string, root: AuthoredRoot, bytes: Buffer, ref: string, from: string) => {
    const entry = entryOf(absPath, root);
    files.set(absPath, { bytes, entry });
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch {
      failures.push({ ref, from, reason: "invalid JSON" });
      return;
    }
    for (const next of refsOf(raw)) {
      const target = resolve(dirname(absPath), next);
      if (files.has(target)) continue;
      const targetRoot = rootOf(roots, target);
      if (targetRoot === undefined) {
        failures.push({ ref: next, from: entry, reason: "outside the authored workflow roots" });
        continue;
      }
      const confined = confineToProjectRoot(targetRoot.dir, relative(targetRoot.dir, target));
      const targetBytes = confined === undefined ? undefined : readArtifact(confined);
      if (targetBytes === undefined) {
        failures.push({ ref: next, from: entry, reason: "file not found" });
        continue;
      }
      visit(target, targetRoot, targetBytes, next, entry);
    }
  };
  visit(rootPath, rootRoot, rootBytes, handle, handle);

  if (failures.length > 0) return { ok: false, status: 422, failures };
  const name = basename(rootPath);
  if (files.size === 1) {
    return { ok: true, contentType: "application/json", fileName: name, bytes: rootBytes };
  }

  const stem = name.slice(0, -SUFFIX.length);
  const entries = [...files.values()].sort((a, b) => (a.entry < b.entry ? -1 : 1));
  const zipped: Record<string, Uint8Array> = {};
  for (const { entry, bytes } of entries) zipped[`${stem}/${entry}`] = bytes;
  return {
    ok: true,
    contentType: "application/zip",
    fileName: `${stem}.zip`,
    bytes: zipSync(zipped, { mtime: ZIP_MTIME }),
  };
}
