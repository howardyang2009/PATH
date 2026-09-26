import type { WorkflowNode } from "./node-type.js";

/**
 * One body of nodes nested inside a control block: `concurrent` marks `parallel` branches, siblings that run at once
 * and can race to publish, and a single-node slot is wrapped in a one-element array.
 */
export interface NodeChildBody {
  nodes: WorkflowNode[];
  /**
   * JSON path segments from the owning node to this slot; only a `sequence` body lands on its array (`["body"]`),
   * every other slot on its one node.
   */
  path: (string | number)[];
  concurrent: boolean;
}

/** The JSON path of `child.nodes[index]` relative to its owning node; only a `sequence` body indexes an array. */
export function childNodePath(child: NodeChildBody, index: number): (string | number)[] {
  return child.path[0] === "body" ? [...child.path, index] : child.path;
}

/**
 * The child-slot shape of each control block: which of a node's own keys hold nested bodies, and how each is shaped.
 */
export type ChildSlot =
  /** An own key holding an ordered node array (`sequence`'s `body`, `parallel`'s `branches`). */
  | { key: "body" | "branches"; shape: "node-list" }
  /** An own key holding exactly one node (`while-do`'s `node`, a branch's `else`). */
  | { key: "node" | "else"; shape: "node" }
  /** An own key holding `{ when, node }` arms, each a single-node occupant (`branch`'s `arms`). */
  | { key: "arms"; shape: "arm-list" };

/** Every `WorkflowNode` member that nests a child body — the control block types, derived structurally. */
type BranchingType = Extract<
  WorkflowNode,
  { body: unknown } | { branches: unknown } | { node: unknown } | { arms: unknown }
>["type"];

/**
 * Every controller type name — the engine-evaluated control constructs (CONTEXT.md § Controller) — derived from the
 * node union so the set cannot drift.
 */
export type ControllerType = Extract<
  WorkflowNode,
  { type: "parallel" | "branch" | "while-do" | "sequence" | "checkpoint" | "goto" }
>["type"];

// The six controllers — five Structure Controllers and the one Graph Controller, `goto` (ADR 0057). A
// record, not a `Set`, so membership is `Object.hasOwn` and a plugin type named `constructor` is not a controller.
const CONTROLLER_TYPES = {
  parallel: true,
  branch: true,
  "while-do": true,
  sequence: true,
  checkpoint: true,
  goto: true,
} as const satisfies Record<ControllerType, true>;

// The one shape table, bound to the node union by `satisfies`: every control block that nests a body must
// appear, and none that does not, so the typed reader and the pre-parse JSON reader cannot disagree.
export const CONTROL_CHILD_SLOTS = {
  sequence: [{ key: "body", shape: "node-list" }],
  parallel: [{ key: "branches", shape: "node-list" }],
  "while-do": [{ key: "node", shape: "node" }],
  branch: [
    { key: "arms", shape: "arm-list" },
    { key: "else", shape: "node" },
  ],
} as const satisfies Record<BranchingType, readonly ChildSlot[]>;

/**
 * Where a node's children are — **the one statement of the descent** — or `[]` for a leaf; the `never` guard forces a
 * new node type to say where its children are, and a `workflow` step's ref'd file is never descended.
 */
export function childBodies(node: WorkflowNode): NodeChildBody[] {
  switch (node.type) {
    case "parallel":
      // Each branch is a single node carrying its own id + name; siblings run at once, so they can race to publish.
      return node.branches.map((branch, branchIndex) => ({
        nodes: [branch],
        path: ["branches", branchIndex],
        concurrent: true,
      }));
    case "branch": {
      // Each arm's occupant and the `else` are single nodes; exactly one arm runs, so arms are never concurrent.
      const bodies: NodeChildBody[] = node.arms.map((arm, armIndex) => ({
        nodes: [arm.node],
        path: ["arms", armIndex, "node"],
        concurrent: false,
      }));
      if (node.else) bodies.push({ nodes: [node.else], path: ["else"], concurrent: false });
      return bodies;
    }
    case "while-do":
      // The loop body is a single node; iterations are sequential, so a key published on two passes is not a race.
      return [{ nodes: [node.node], path: ["node"], concurrent: false }];
    case "sequence":
      return [{ nodes: node.body, path: ["body"], concurrent: false }];
    case "prompt":
    case "binary":
    case "workflow":
    case "checkpoint":
    case "goto":
      return [];
    // The `never` assignment is the compile-time guard; `[]` the runtime one, for a hand-constructed
    // file that reached a walk without passing the schema. Rejecting an unknown type is the executor's job.
    default: {
      const exhaustive: never = node;
      void exhaustive;
      return [];
    }
  }
}

/** Every node in a body, depth-first, including those nested inside control blocks. */
export function* walkNodes(nodes: WorkflowNode[]): Generator<WorkflowNode> {
  for (const node of nodes) {
    yield node;
    for (const child of childBodies(node)) yield* walkNodes(child.nodes);
  }
}

/**
 * Whether a node of this `type` is a **step** (a leaf step type or `workflow`) rather than a controller:
 * only steps execute on workers and mint a run of their own (CONTEXT.md Invariant 1). Derived from the
 * controller set, never a fixed list of built-in names — plugin leaf types arrive at scan time, and
 * `while-do` is excluded even though it mints an iteration-container run per pass (ADR 0037).
 */
export function isStepType(type: string): boolean {
  return !Object.hasOwn(CONTROLLER_TYPES, type);
}

/**
 * The operator-facing name of a control block that makes a rerun-boundary locus illegal (spec §6); a `sequence` is
 * not one, since its body is transparent (ADR 0064).
 */
export type ControlBlockKind = "loop" | "parallel" | "branch";

const CONTROL_BLOCK_KINDS: Record<"while-do" | "parallel" | "branch", ControlBlockKind> = {
  "while-do": "loop",
  parallel: "parallel",
  branch: "branch",
};

/**
 * The **serial order** of a body (ADR 0064): every `sequence` replaced by its children, recursively, never entering a
 * `while-do`, `parallel`, or `branch`.
 */
export function serialOrder(body: WorkflowNode[]): WorkflowNode[] {
  return body.flatMap((node) => (node.type === "sequence" ? serialOrder(node.body) : [node]));
}

/**
 * The innermost control block enclosing `targetId` that makes it an illegal rerun-boundary locus, or `undefined`
 * when the target is in the body's serial order or absent — the one statement of that lookup.
 */
export function enclosingControlBlock(
  body: WorkflowNode[],
  targetId: string,
): ControlBlockKind | undefined {
  const search = (
    nodes: WorkflowNode[],
    enclosing: WorkflowNode | undefined,
  ): WorkflowNode | undefined | null => {
    for (const node of nodes) {
      if (node.id === targetId) return enclosing;
      const next = node.type === "sequence" ? enclosing : node;
      for (const child of childBodies(node)) {
        const found = search(child.nodes, next);
        if (found !== null) return found;
      }
    }
    return null;
  };
  const container = search(body, undefined);
  if (!container) return undefined;
  return CONTROL_BLOCK_KINDS[container.type as keyof typeof CONTROL_BLOCK_KINDS];
}

/**
 * Rebuild `node` with each child body passed through `fn` — the write counterpart of `childBodies`; a single-node
 * slot hands `fn` a one-element array and takes the first node back, and a leaf is returned unchanged.
 */
export function mapChildBodies(
  node: WorkflowNode,
  fn: (body: WorkflowNode[]) => WorkflowNode[],
): WorkflowNode {
  switch (node.type) {
    case "sequence":
      return { ...node, body: fn(node.body) };
    case "parallel":
      return { ...node, branches: fn(node.branches) };
    case "while-do":
      return { ...node, node: fn([node.node])[0]! };
    case "branch": {
      const arms = node.arms.map((arm) => ({ ...arm, node: fn([arm.node])[0]! }));
      const elseNode = node.else ? fn([node.else])[0]! : undefined;
      return { ...node, arms, else: elseNode };
    }
    case "prompt":
    case "binary":
    case "workflow":
    case "checkpoint":
    case "goto":
      return node;
    default: {
      const exhaustive: never = node;
      void exhaustive;
      return node;
    }
  }
}
