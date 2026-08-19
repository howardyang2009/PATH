import type { WorkflowNode } from "./node-type.js";

/**
 * One body of nodes nested inside a control block, with what a caller needs to say something about
 * it. The block grammar's descent rule (workflow-format-v0.md §3) lives in `childBodies` below and
 * nowhere else.
 */
export interface NodeChildBody {
  /**
   * The nodes of this child slot. A `body` slot (`sequence`) carries its whole array; a single-`node`
   * slot (a `while-do` body, a branch arm, an `else`) and each `parallel` branch carry exactly one
   * node, wrapped in a one-element array so every caller walks a list (`@2` §3.1).
   */
  nodes: WorkflowNode[];
  /** JSON path segments from the owning node to this body, for error reporting. */
  path: (string | number)[];
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
      // Each branch is a single node carrying its own `id` + `name` (`@2` §4.3) — wrapped so callers
      // walk a list. Siblings run at once, so they can race to publish.
      return node.branches.map((branch, branchIndex) => ({
        nodes: [branch],
        path: ["branches", branchIndex],
        concurrent: true,
      }));
    case "branch": {
      // Each arm's occupant and the `else` are single nodes (`@2` §4.3). Exactly one arm runs, so
      // arms are alternatives rather than siblings — never concurrent.
      const bodies: NodeChildBody[] = node.arms.map((arm, armIndex) => ({
        nodes: [arm.node],
        path: ["arms", armIndex, "node"],
        concurrent: false,
      }));
      if (node.else) bodies.push({ nodes: [node.else], path: ["else"], concurrent: false });
      return bodies;
    }
    case "while-do":
      // The loop body is a single node (`@2` §4.3). Iterations are sequential, so a key published on
      // two passes is not a race.
      return [{ nodes: [node.node], path: ["node"], concurrent: false }];
    case "sequence":
      // A `sequence`'s `body` is an ordered node array (`@2` §4.4); the nodes run in sequence, so a
      // key published by two of them is not a race.
      return [{ nodes: node.body, path: ["body"], concurrent: false }];
    case "prompt":
    case "binary":
    case "workflow":
    case "checkpoint":
      return [];
    // Two guards, as at the engine's node dispatch. The `never` assignment is the compile-time one:
    // a node type added to the format must say where its children are or nothing builds. The `[]` is
    // the runtime one — a hand-constructed file can reach a walk without passing the schema, and a
    // caller sweeping it (`collectRunConfigs`) must find no children rather than be handed a node
    // where it expects a list. Rejecting the unknown type is the executor's job, not the walk's.
    default: {
      const exhaustive: never = node;
      void exhaustive;
      return [];
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
