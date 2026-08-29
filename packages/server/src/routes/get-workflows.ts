import { readdirSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join, relative, resolve } from "node:path";
import { loadWorkflowTree } from "@path/engine";
import type { ListWorkflowsResponse, WorkflowSummary } from "@path/schema";
import { sendJson } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * Every `*.workflow.json` under `root`, as absolute paths, sorted for a deterministic response.
 * Skips `.path/`, `node_modules`, and any dot-directory (server-api-v0.md §6). Symlinks — whether to
 * a file or a directory — are neither followed nor listed: the loader canonicalizes lexically
 * (`resolve`, not `realpath`), so following one here would alias a nested file as a discovered root
 * (valid-root-detection.md).
 */
function scanWorkflowFiles(root: string): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Checked before isDirectory()/isFile(): a symlink reports neither, so this both avoids
      // following a symlinked dir and drops a symlinked file rather than aliasing it.
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

/**
 * Best-effort top-level `id`/`name` for a file that failed to load, so an invalid entry stays
 * human-legible in the list (server-api-v0.md §6). `null` for either field the shallow parse can't
 * recover — a syntactically broken file yields `{ id: null, name: null }`.
 */
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
 * flagged whether it is a root or also reachable as another workflow's nested `workflow` ref. Pure
 * read — no engine exec path. Fresh scan each call, no pagination or cache.
 *
 * Two passes over the discovered files. The first loads each with `loadWorkflowTree` and, for every
 * one that loads, folds its nested-ref set — `keys(workflow.files) \ {itself}`, all absolute — into a
 * shared `referenced` set. The second builds the response: a file that loaded is `is_root: false`
 * exactly when some valid root referenced it (ADR 0011 — list all, flag roots), `is_root: true`
 * otherwise; a file that failed to load carries `is_root: null` (a failed load has no `workflow.files`,
 * so it cannot be classified) with the shared error envelope and a best-effort id/name.
 */
export async function handleGetWorkflows(res: ServerResponse, ctx: RunsRouteContext): Promise<void> {
  // Canonicalized so scan paths (`join` off this root) match `loadWorkflowTree`'s keys (`resolve`)
  // exactly — the map lookups below assume that equality. `project.dir` is already `resolve`d today
  // (openProject); resolving again is a cheap belt-and-braces that keeps the assumption local.
  const projectDir = resolve(ctx.project.dir);
  const absPaths = scanWorkflowFiles(projectDir);

  // `loadWorkflowTree` is async now (ADR 0019 sub-15): the N per-call loads run concurrently, one
  // `Promise.all`, rather than one blocking scan+parse after another.
  const loaded = await Promise.all(
    absPaths.map(async (absPath) => ({ absPath, result: await loadWorkflowTree(absPath) })),
  );

  // A discovered file reachable as a *valid* root's nested ref. Only successful loads contribute:
  // a file whose own load failed carries no ref set, and its own `is_root` is null regardless.
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
      // The root of this file's own load is the file itself — its parsed id/name.
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
