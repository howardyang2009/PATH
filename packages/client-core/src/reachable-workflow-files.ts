import { type WorkflowFile, walkNodes } from "@path/schema";
import type { PathApiClient } from "./api-client.js";

/**
 * Resolve a `workflow` step's `ref` (relative to the referencing file, workflow-format-v0.md §4.2)
 * to a path relative to the store dir — the shape `getWorkflowFile` reads. It is the client-side,
 * POSIX-only mirror of the engine's `resolve(dirname(parentPath), ref)`: the parent file's directory
 * plus the ref, with `.`/`..` collapsed. Store paths are always `/`-separated and relative, so no
 * drive letters or absolute roots enter — a `..` that would climb past the root is clamped, matching
 * the server's own refusal to serve a path that escapes the project.
 */
function resolveRef(parentPath: string, ref: string): string {
  const out = parentPath.split("/").slice(0, -1); // the parent file's directory
  for (const segment of ref.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * The root workflow file and every file its `workflow` steps ref, transitively — the set an awaiting
 * `person-activity` leaf may live in (issue #486 follow-up). A leaf in a nested workflow file is
 * invisible to a root-only read, so the awaiting surface (`awaitingNodeForRun`) needs the whole
 * reachable set to find its node by id.
 *
 * Breadth-first from `rootPath`, following each file's `workflow` refs; a path is fetched once (the
 * `seen` set also stops a ref cycle a hand-built file could hold). The read tolerates a missing or
 * unparseable file — a since-moved ref, or a nested file the reader cannot see — by skipping it rather
 * than failing the set, exactly as the single-file read degrades today; a `rootPath` that fails yields
 * an empty array, so the caller's awaiting surface falls back to the schema-less submit. The root file
 * is first in the result, so a caller that also wants the root alone (the `Resume from …` legal-K
 * check) reads `files[0]`.
 */
export async function loadReachableWorkflowFiles(
  client: PathApiClient,
  rootPath: string,
): Promise<WorkflowFile[]> {
  const files: WorkflowFile[] = [];
  const seen = new Set<string>([rootPath]);
  const queue: string[] = [rootPath];

  while (queue.length > 0) {
    const path = queue.shift()!;
    let file: WorkflowFile;
    try {
      const raw = await client.getWorkflowFile(path);
      file = JSON.parse(raw.text) as WorkflowFile;
    } catch {
      // A gone/moved ref or an unreadable file drops out of the set; the surface degrades, never fails.
      continue;
    }
    files.push(file);
    for (const node of walkNodes(file.body)) {
      if (node.type !== "workflow") continue;
      const childPath = resolveRef(path, node.ref);
      if (seen.has(childPath)) continue;
      seen.add(childPath);
      queue.push(childPath);
    }
  }

  return files;
}
