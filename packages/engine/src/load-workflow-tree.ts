import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { safeParseWorkflowFile, type WorkflowFile, type WorkflowNode } from "@path/schema";

export interface WorkflowTree {
  /** Absolute path of the entry file passed to `path run`. */
  rootPath: string;
  /** Every file reachable from the root via `workflow` step refs, keyed by absolute path. */
  files: Map<string, WorkflowFile>;
}

export type LoadResult = { success: true; tree: WorkflowTree } | { success: false; errors: string[] };

// Recurses through control-node bodies the same way @path/schema's own id/publish-key
// collectors do — a `workflow` step's ref can sit inside any nesting of blocks.
function collectWorkflowRefs(nodes: WorkflowNode[]): string[] {
  const refs: string[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "workflow":
        refs.push(node.ref);
        break;
      case "parallel":
        for (const branch of node.branches) {
          refs.push(...collectWorkflowRefs(branch.body));
        }
        break;
      case "branch":
        for (const arm of node.arms) {
          refs.push(...collectWorkflowRefs(arm.body));
        }
        if (node.else) {
          refs.push(...collectWorkflowRefs(node.else));
        }
        break;
      case "while-do":
        refs.push(...collectWorkflowRefs(node.body));
        break;
      default:
        break;
    }
  }

  return refs;
}

/**
 * Loads and validates the whole file tree reachable from `entryPath` via `workflow` step
 * refs, so authoring errors anywhere in the tree — schema violations, ref cycles,
 * unresolvable refs — surface before any step executes (format doc §10).
 */
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
