import { type WorkflowFile, walkNodes } from "@path/schema";
import type { PathApiClient } from "./api-client.js";
import { type AwaitingNode, type AwaitingRun, awaitingNodeForRun } from "./awaiting-node.js";

/**
 * The files a run's node ids resolve against, behind the one question the read surfaces ask of them:
 * which awaiting node does this run show? A surface reaches the set by reading the project (the
 * Viewer, and the Designer's dock) or by holding files it already has (a test, a frozen fixture).
 */

/** The files a run's tree may hold nodes in, as the awaiting surfaces consume them. */
export interface RunFileSet {
  /** The file the run was launched from — the root of the tree, and the file the `Resume from …`
   * legal-K check reads; `null` when no file could be read. */
  readonly rootFile: WorkflowFile | null;
  /** The awaiting node `run` resolves to, or `null` when no file holds its node id or the node is
   * no longer a `person-activity`. */
  awaitingNode(run: AwaitingRun): AwaitingNode | null;
}

/** The set the caller already holds — the files a disk read or a fixture produced, root first. */
export function runFileSetOf(files: readonly WorkflowFile[]): RunFileSet {
  return {
    rootFile: files[0] ?? null,
    awaitingNode: (run) => awaitingNodeForRun(files, run),
  };
}

/** The set a surface has no files for yet: every question reads as unresolved. */
export const EMPTY_RUN_FILE_SET: RunFileSet = runFileSetOf([]);

/** Client-side mirror of the engine's `resolve(dirname(parentPath), ref)`: `.`/`..` collapsed, a
 * `..` past the root clamped — matching the server's refusal to serve a path that escapes the
 * project. */
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
 * The root workflow file and every file its `workflow` refs reach, transitively — the set that may
 * hold an awaiting leaf, which a root-only read cannot see. Breadth-first, each path fetched once
 * (`seen` also stops a ref cycle); a missing or unparseable file is skipped, so the set degrades
 * rather than failing, and the root file is first. A read, not a lease (ADR 0017).
 */
export async function runFileSetFromDisk(
  client: PathApiClient,
  rootPath: string,
): Promise<RunFileSet> {
  const files: WorkflowFile[] = [];
  const seen = new Set<string>([rootPath]);
  const queue: string[] = [rootPath];

  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    let file: WorkflowFile;
    try {
      const raw = await client.getWorkflowFile(path);
      file = JSON.parse(raw.text) as WorkflowFile;
    } catch {
      // A gone/moved ref or an unreadable file drops out of the set; the surface degrades, never
      // fails.
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

  return runFileSetOf(files);
}
