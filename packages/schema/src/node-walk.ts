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
 * Returns `[]` for a leaf — the step kinds, `checkpoint` and `goto` have no nested bodies. Deliberately
 * does **not** descend into a `workflow` step's ref'd file: that file has its own isolated context
 * and its own validation pass.
 */
/**
 * The child-slot shape of each control block: which of a node's own keys hold its nested bodies, and
 * how each is shaped. `childBodies` above reads this shape through its typed, `never`-guarded switch;
 * a consumer that must walk the same descent **before a file is schema-parsed** — the designer's open
 * pipeline, over raw JSON — reads this table instead of re-spelling the descent a fourth time.
 */
export type ChildSlot =
  /** An own key holding an ordered node array (`sequence`'s `body`, `parallel`'s `branches`). */
  | { key: "body" | "branches"; shape: "node-list" }
  /** An own key holding exactly one node (`while-do`'s `node`, a branch's `else`). */
  | { key: "node" | "else"; shape: "node" }
  /** An own key holding `{ when, node }` arms, each a single-node occupant (`branch`'s `arms`). */
  | { key: "arms"; shape: "arm-list" };

/** Every `WorkflowNode` member that nests a child body — the control block types, derived structurally. */
type BranchingType = Extract<WorkflowNode, { body: unknown } | { branches: unknown } | { node: unknown } | { arms: unknown }>["type"];

/**
 * Every controller type name — the engine-evaluated control constructs (CONTEXT.md § Controller). A
 * controller has no worker, no task, and no run; the engine of the enclosing workflow evaluates it.
 * Derived from the node union rather than listed as bare strings, so the set below cannot drift from
 * the format.
 */
export type ControllerType = Extract<
  WorkflowNode,
  { type: "parallel" | "branch" | "while-do" | "sequence" | "checkpoint" | "goto" }
>["type"];

/**
 * The six controllers — five Structure Controllers and the one Graph Controller, `goto` (ADR 0057) —
 * as a record rather than a set: `ControllerType` is derived from the node
 * union, so a control construct added to the format fails to compile until it is listed here — the
 * same exhaustive guard `CONTROL_CHILD_SLOTS`' `satisfies` puts on the descent. A record (rather than
 * a `Set`) lets the membership test be `Object.hasOwn`, so a plugin type named after a prototype key
 * (`constructor`, `toString`) is never mistaken for a controller.
 */
const CONTROLLER_TYPES = {
  parallel: true,
  branch: true,
  "while-do": true,
  sequence: true,
  checkpoint: true,
  goto: true,
} as const satisfies Record<ControllerType, true>;

/**
 * The one shape table. `satisfies Record<BranchingType, …>` binds it to the node union: every control
 * block that nests a child body must appear here, and none may appear that does not. A control block
 * added to the format is forced into `childBodies` by its `never` guard and into this table by the
 * `satisfies`, so the typed reader and the pre-parse JSON reader can never disagree on the descent.
 */
export const CONTROL_CHILD_SLOTS = {
  sequence: [{ key: "body", shape: "node-list" }],
  parallel: [{ key: "branches", shape: "node-list" }],
  "while-do": [{ key: "node", shape: "node" }],
  branch: [
    { key: "arms", shape: "arm-list" },
    { key: "else", shape: "node" },
  ],
} as const satisfies Record<BranchingType, readonly ChildSlot[]>;

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
    // A goto's route is a `target` name, not an edge (ADR 0057 §4): it nests no body.
    case "goto":
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

/**
 * Whether a node of this `type` is a **step** — a leaf step type or `workflow` — rather than a
 * controller. Only steps execute on workers and mint a run of their own (CONTEXT.md Invariant 1), so
 * this is exactly the node-grain unit a Resume can reuse, a rerun boundary can classify, and the
 * prefix rule reads.
 *
 * Derived from the controller set, **not** listed as the built-in step names. A step-type plugin
 * folder contributes a leaf type the engine discovers at scan time (ADR 0019/0021), so "which types
 * are steps" is a fact about what is installed, never a fixed list — an allowlist of `prompt`,
 * `binary`, and `person-activity` silently skipped every other plugin type, in the reuse plan, in the
 * rerun-boundary suppress set, and in legal-K's prefix rule alike.
 *
 * `while-do` is a controller, so it is excluded here even though it mints an iteration-container run
 * per pass (ADR 0037): that is container grain, not node grain, and `planReuse`'s one-succeeded-row-
 * per-id guard would refuse a loop's many rows anyway. A control block owns no run at all, so neither
 * class can arrive through this predicate.
 *
 * The **one authority** the engine's reuse plan (`plan-reuse.ts`), the executor's suppress set
 * (`run-workflow.ts`) and the client's eager legal-K check (`legal-k.ts`, `@path/client-core`) all
 * read — a bare literal copied into each would drift silently.
 */
export function isStepType(type: string): boolean {
  return !Object.hasOwn(CONTROLLER_TYPES, type);
}

/**
 * The operator-facing name of a control block, as the rerun-boundary refusal taxonomy spells it
 * (spec §6): `loop` is a `while-do`, the others keep their type name (CONTEXT.md § Rerun-boundary).
 */
export type ControlBlockKind = "loop" | "parallel" | "branch" | "sequence";

const CONTROL_BLOCK_KINDS: Record<"while-do" | "parallel" | "branch" | "sequence", ControlBlockKind> = {
  "while-do": "loop",
  parallel: "parallel",
  branch: "branch",
  sequence: "sequence",
};

/**
 * The innermost control block enclosing `targetId` in `body`, or `undefined` when `targetId` is a
 * top-level node (enclosed by nothing) or absent. Walks the block grammar via `childBodies` and names
 * the nearest control node whose child body holds the target — what the rerun-boundary "inside a … body"
 * refusal names (`@path/engine`'s `resolveLegalK`, the client's eager mirror). The **one** statement of
 * that locus lookup, so the two never disagree on which block a node sits in.
 */
export function enclosingControlBlock(body: WorkflowNode[], targetId: string): ControlBlockKind | undefined {
  const search = (nodes: WorkflowNode[], enclosing: WorkflowNode | undefined): WorkflowNode | undefined => {
    for (const node of nodes) {
      if (node.id === targetId) return enclosing;
      for (const child of childBodies(node)) {
        const found = search(child.nodes, node);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const container = search(body, undefined);
  if (container === undefined) return undefined;
  return CONTROL_BLOCK_KINDS[container.type as keyof typeof CONTROL_BLOCK_KINDS];
}

/**
 * Rebuild `node` with each of its child bodies passed through `fn` — **the write counterpart of
 * `childBodies`**. `childBodies` reads where a node's children are; `mapChildBodies` writes them back,
 * so a caller rebuilding the tree (the designer's edit ops) states the block grammar's descent nowhere
 * of its own. A single-node slot (a `while-do` body, a branch arm, an `else`) hands `fn` a one-element
 * array and takes the first node back; a `sequence` body and a `parallel` branch list hand it the whole
 * array. A branch arm's `when` and every other own field are preserved. A leaf carries no child body, so
 * `fn` never runs and the node returns unchanged.
 *
 * It shares `childBodies`' `never` guard: a node type added to the format must say where its children
 * are here too, or nothing builds — so the read and the write can never disagree on the shape.
 */
export function mapChildBodies(node: WorkflowNode, fn: (body: WorkflowNode[]) => WorkflowNode[]): WorkflowNode {
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
