import type { WorkflowNode } from "./node-type.js";

/**
 * One body of nodes nested inside a control block, with what a caller needs to say something about
 * it. The block grammar's descent rule (workflow-format-v0.md §3) lives in `childBodies` below and
 * nowhere else.
 */
export interface NodeChildBody {
  nodes: WorkflowNode[];
  /** JSON path segments from the owning node to this body, for error reporting. */
  path: (string | number)[];
  /** A `parallel` branch carries its own id, which is not a node's — nothing else does. */
  branchId?: string;
  /** True for `parallel` branches: siblings that run at once, and so can race to publish. */
  concurrent: boolean;
}

/**
 * Where a node's children are. **The one statement of the block grammar's descent.**
 *
 * It was stated five times: three collectors in this package, one in `@path/engine`, and the
 * executor's dispatch. Four of those five ended in `default: break`, so a block type added to the
 * format was not scanned for id uniqueness, publish-key collisions, or `workflow` refs — it was
 * *silently skipped* rather than rejected, and the first symptom would be a workflow that validates
 * and then misbehaves. The `never` guard below turns that into a compile error: a new node type must
 * say where its children are, or nothing builds.
 *
 * Returns `[]` for a leaf — the four step and checkpoint kinds have no nested bodies. Deliberately
 * does **not** descend into a `workflow` step's ref'd file: that file has its own isolated context
 * and its own validation pass.
 */
export function childBodies(node: WorkflowNode): NodeChildBody[] {
  switch (node.type) {
    case "parallel":
      return node.branches.map((branch, branchIndex) => ({
        nodes: branch.body,
        path: ["branches", branchIndex, "body"],
        branchId: branch.id,
        concurrent: true,
      }));
    case "branch": {
      const bodies: NodeChildBody[] = node.arms.map((arm, armIndex) => ({
        nodes: arm.body,
        path: ["arms", armIndex, "body"],
        concurrent: false,
      }));
      // Exactly one arm runs, so arms are alternatives rather than siblings — never concurrent.
      if (node.else) bodies.push({ nodes: node.else, path: ["else"], concurrent: false });
      return bodies;
    }
    case "while-do":
      // Iterations are sequential, so a key published on two passes is not a race.
      return [{ nodes: node.body, path: ["body"], concurrent: false }];
    case "prompt":
    case "binary":
    case "workflow":
    case "checkpoint":
      return [];
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

/**
 * Every node in a body, depth-first, including those nested inside control blocks — for a caller
 * that wants the nodes and nothing about where they sat. Callers needing the JSON path, a parallel
 * branch's id, or which siblings are concurrent use `childBodies` directly.
 */
export function* walkNodes(nodes: WorkflowNode[]): Generator<WorkflowNode> {
  for (const node of nodes) {
    yield node;
    for (const child of childBodies(node)) yield* walkNodes(child.nodes);
  }
}
