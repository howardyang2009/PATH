import { type WorkflowFile, walkNodes } from "@path/schema";
import type { PathApiClient } from "./api-client.js";

/** Client-side mirror of the engine's `resolve(dirname(parentPath), ref)`: `.`/`..` collapsed, a `..`
 * past the root clamped — matching the server's refusal to serve a path that escapes the project. */
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

/** The root workflow file and every file its `workflow` refs reach, transitively — the set that may
 * hold an awaiting leaf, which a root-only read cannot see. Breadth-first, each path fetched once
 * (`seen` also stops a ref cycle); a missing or unparseable file is skipped, so the set degrades
 * rather than failing, and the root file is first. */
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
