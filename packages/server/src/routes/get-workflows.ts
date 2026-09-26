import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadWorkflowTree } from "@path/engine";
import type { ListWorkflowsResponse, WorkflowSummary } from "@path/schema";
import { sendJson } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/**
 * Every `*.workflow.json` under `root`, as absolute paths, sorted. Skips `.path/`, `node_modules`, and
 * any dot-directory. Symlinks are neither followed nor listed: the loader canonicalizes lexically
 * (`resolve`, not `realpath`), so following one would alias a nested file as a discovered root.
 */
function scanWorkflowFiles(root: string): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Checked before isDirectory()/isFile(): a symlink reports neither.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".workflow.json")) {
        found.push(join(dir, entry.name));
      }
    }
  }

  walk(root);
  return found.sort();
}

/** Best-effort top-level `id`/`name` so an invalid entry stays human-legible in the list; `null` when
 * the shallow parse cannot recover either field. */
function shallowIdentity(absPath: string): { id: string | null; name: string | null } {
  try {
    const raw = JSON.parse(readFileSync(absPath, "utf8")) as Record<string, unknown>;
    return {
      id: typeof raw.id === "string" ? raw.id : null,
      name: typeof raw.name === "string" ? raw.name : null,
    };
  } catch {
    return { id: null, name: null };
  }
}

/**
 * `GET /v0/workflows` (server-api-v0.md §6): discover every workflow under the project root, each
 * flagged `is_root`. A file that loaded is `is_root: false` exactly when some valid root referenced it,
 * `true` otherwise; a file that failed to load carries `is_root: null` (no ref set) and its error.
 */
export async function handleGetWorkflows({ res, ctx }: ApiRequest): Promise<void> {
  // `resolve`d so scan paths (`join` off this root) match `loadWorkflowTree`'s keys exactly; the map
  // lookups below assume that equality.
  const projectDir = resolve(ctx.project.dir);
  const absPaths = scanWorkflowFiles(projectDir);

  const loaded = await Promise.all(
    absPaths.map(async (absPath) => ({ absPath, result: await loadWorkflowTree(absPath) })),
  );

  // A discovered file reachable as a *valid* root's nested ref.
  const referenced = new Set<string>();
  for (const { absPath, result } of loaded) {
    if (!result.success) continue;
    for (const key of result.workflow.files.keys()) {
      if (key !== absPath) referenced.add(key);
    }
  }

  const workflows: WorkflowSummary[] = loaded.map(({ absPath, result }) => {
    const relativePath = relative(projectDir, absPath);
    if (result.success) {
      const file = result.workflow.rootFile;
      return {
        relative_path: relativePath,
        id: file.id,
        name: file.name,
        valid: true,
        is_root: !referenced.has(absPath),
        error: null,
      };
    }
    const { id, name } = shallowIdentity(absPath);
    return {
      relative_path: relativePath,
      id,
      name,
      valid: false,
      is_root: null,
      error: { message: result.errors[0] ?? "workflow load failed", details: result.errors },
    };
  });

  const body: ListWorkflowsResponse = { workflows };
  sendJson(res, 200, body);
}
