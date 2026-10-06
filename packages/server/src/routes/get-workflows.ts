import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { loadWorkflowTree } from "@path/engine";
import type { ListWorkflowsResponse, WorkflowSummary } from "@path/schema";
import { readOnlyFor } from "../creator-table.js";
import type { RouteReply } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/** Best-effort top-level `id`/`name` so an invalid entry stays human-legible in the list; `null`
 * when the shallow parse cannot recover either field. */
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
 * `GET /v0/workflows` (server-api-v0.md §6, ADR 0085, ADR 0086): discover every workflow in the
 * user, shared and shipped roots, each flagged `is_root`. A file that loaded is `is_root: false`
 * exactly when some valid root referenced it, `true` otherwise; a file that failed to load carries
 * `is_root: null` (no ref set) and its error.
 */
export async function handleGetWorkflows({ ctx }: ApiRequest): Promise<RouteReply> {
  const { layout, creators } = ctx;
  const scanned = layout.files("workflow");
  const loaded = await Promise.all(
    scanned.map(async ({ absPath, root }) => ({
      absPath,
      root,
      result: await loadWorkflowTree(absPath, { refAllowed: layout.inView }),
    })),
  );

  // A discovered file reachable as a *valid* root's nested ref.
  const referenced = new Set<string>();
  for (const { absPath, result } of loaded) {
    if (!result.success) continue;
    for (const key of result.workflow.files.keys()) {
      if (key !== absPath) referenced.add(key);
    }
  }

  const workflows: WorkflowSummary[] = loaded.map(({ absPath, root, result }) => {
    // A writable row is named by its project path, the launch and open handle; a shipped row by
    // its path in the shipped root, the handle Copy takes.
    const rootPath = relative(root.dir, absPath);
    const place = {
      relative_path: root.writable ? relative(layout.projectDir, absPath) : rootPath,
      origin: root.origin,
      root_path: rootPath,
      action: root.writable ? "open" : result.success ? "copy" : "none",
      read_only: readOnlyFor(layout, creators, { absPath, root }),
    } as const;
    if (result.success) {
      const file = result.workflow.rootFile;
      return {
        ...place,
        id: file.id,
        name: file.name,
        valid: true,
        is_root: !referenced.has(absPath),
        error: null,
      };
    }
    const { id, name } = shallowIdentity(absPath);
    return {
      ...place,
      id,
      name,
      valid: false,
      is_root: null,
      error: { message: result.errors[0] ?? "workflow load failed", details: result.errors },
    };
  });

  const roots = layout
    .roots("workflow")
    .flatMap((root) =>
      root.origin === "shipped"
        ? []
        : [{ origin: root.origin, relative_path: relative(layout.projectDir, root.dir) }],
    )
    .reverse();
  const body: ListWorkflowsResponse = { workflows, roots };
  return { status: 200, body };
}
