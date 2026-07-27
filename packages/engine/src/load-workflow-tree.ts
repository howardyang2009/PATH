import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { safeParseWorkflowFile, walkNodes, type WorkflowFile, type WorkflowNode } from "@path/schema";

export interface WorkflowTree {
  /** Absolute path of the entry file passed to `path run`. */
  rootPath: string;
  /** Every file reachable from the root via `workflow` step refs, keyed by absolute path. */
  files: Map<string, WorkflowFile>;
}

export type LoadResult = { success: true; tree: WorkflowTree } | { success: false; errors: string[] };

// A `workflow` step's ref can sit inside any nesting of control blocks, so this walks the whole
// body — using @path/schema's descent rather than restating it, which is what let a new block type
// silently hide a nested file from the loader (#70).
function collectWorkflowRefs(nodes: WorkflowNode[]): string[] {
  const refs: string[] = [];
  for (const node of walkNodes(nodes)) {
    if (node.type === "workflow") refs.push(node.ref);
  }
  return refs;
}

export function loadWorkflowTree(entryPath: string): LoadResult {
  const files = new Map<string, WorkflowFile>();
  const errors: string[] = [];

  function visit(absPath: string, chain: string[]): void {
    if (chain.includes(absPath)) {
      errors.push(`ref cycle: ${[...chain, absPath].join(" -> ")}`);
      return;
    }

    if (files.has(absPath)) return; // shared ref already fully loaded outside this chain

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(absPath, "utf8"));
    } catch (err) {
      errors.push(`${absPath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const parsed = safeParseWorkflowFile(raw);
    if (!parsed.success) {
      errors.push(...parsed.errors.map((e) => `${absPath}: ${e}`));
      return;
    }

    files.set(absPath, parsed.data);

    for (const ref of collectWorkflowRefs(parsed.data.body)) {
      visit(resolve(dirname(absPath), ref), [...chain, absPath]);
    }
  }

  const rootPath = resolve(entryPath);
  visit(rootPath, []);

  if (errors.length > 0) {
    return { success: false, errors };
  }
  return { success: true, tree: { rootPath, files } };
}
