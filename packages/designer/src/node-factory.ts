import type { Condition, WorkflowNode } from "@path/schema";
import { childBodies } from "@path/schema";

/**
 * Minting new nodes for the canvas (#368, designer-spec § Adding; ADR 0015 node identity). Every node
 * this module makes carries a **client-minted UUIDv4** `id` and a **file-unique** `name`. A block is
 * born with its minimal legal occupants pre-filled by a default leaf step, so a freshly placed
 * `while-do`, `branch`, `parallel`, or `sequence` is already grammar-shaped rather than a slot the
 * author must remember to fill. Duplicating a node clones its whole subtree with **fresh** ids and
 * names, because a paste is a new node, not an alias (ADR 0015: a duplicate gets a fresh id).
 *
 * Names must be unique across the whole file (`workflow-file.ts`), so every mint takes the set of names
 * already in use and derives a free one; a name it hands out is added to that set, so several nodes made
 * in one call (a block and its default occupants) never collide with each other either.
 */

/** A default placeholder condition for a new `branch` arm, `while-do`, or `checkpoint`; edited in the pane later. */
function defaultCondition(): Condition {
  return { type: "exists", path: "context.value" };
}

/** A free name derived from `base`: `base`, then `base-2`, `base-3`, … until one is unused. Reserves the result. */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** A fresh leaf step of `type`, with the type's own required field(s) stubbed empty for the pane to fill. */
function makeLeaf(type: string, used: Set<string>): WorkflowNode {
  const base = { id: crypto.randomUUID(), name: uniqueName(type, used), type };
  switch (type) {
    case "prompt":
      return { ...base, prompt: "" } as WorkflowNode;
    case "binary":
      return { ...base, command: "" } as WorkflowNode;
    case "workflow":
      return { ...base, ref: "" } as WorkflowNode;
    default:
      // A generic registry leaf (e.g. `api-call`): only the envelope is minted; the pane fills its
      // fields. The working model tolerates the empty payload — save-time validation is a later ticket.
      return base as unknown as WorkflowNode;
  }
}

/**
 * A fresh node of `kind`, ready to place. A leaf step kind (`prompt`, `binary`, `workflow`, or a
 * registry plugin type) makes a leaf; a block makes its shell with a default leaf occupant (`defaultLeaf`,
 * the palette's first Steps entry, else `prompt`) filling each minimal-legal slot.
 */
export function createNode(kind: string, used: Set<string>, defaultLeaf = "prompt"): WorkflowNode {
  switch (kind) {
    case "sequence":
      return { id: crypto.randomUUID(), name: uniqueName("sequence", used), type: "sequence", body: [makeLeaf(defaultLeaf, used)] };
    case "parallel":
      return {
        id: crypto.randomUUID(),
        name: uniqueName("parallel", used),
        type: "parallel",
        join: "collect",
        branches: [makeLeaf(defaultLeaf, used)],
      };
    case "branch":
      return {
        id: crypto.randomUUID(),
        name: uniqueName("branch", used),
        type: "branch",
        arms: [{ when: defaultCondition(), node: makeLeaf(defaultLeaf, used) }],
      };
    case "while-do":
      return {
        id: crypto.randomUUID(),
        name: uniqueName("while-do", used),
        type: "while-do",
        condition: defaultCondition(),
        max_iterations: 1,
        node: makeLeaf(defaultLeaf, used),
      };
    case "checkpoint":
      return { id: crypto.randomUUID(), name: uniqueName("checkpoint", used), type: "checkpoint", condition: defaultCondition() };
    default:
      return makeLeaf(kind, used);
  }
}

/** A fresh `branch` arm — a default `when` over a default leaf occupant — for the add-arm affordance. */
export function createArm(used: Set<string>, defaultLeaf = "prompt"): { when: Condition; node: WorkflowNode } {
  return { when: defaultCondition(), node: makeLeaf(defaultLeaf, used) };
}

/**
 * A deep clone of `node` with **fresh** identity throughout: every node in the subtree gets a new
 * UUIDv4 `id` and a new file-unique `name` (the original's name with a `-copy` suffix, uniquified).
 * This is the paste/duplicate case — a copy is a new node, never an alias of the source (ADR 0015).
 */
export function cloneWithFreshIdentity(node: WorkflowNode, used: Set<string>): WorkflowNode {
  const clone = structuredClone(node) as WorkflowNode;
  reidentify(clone, used);
  return clone;
}

/** Walk a cloned subtree, replacing every `id` with a fresh UUIDv4 and every `name` with a free one. */
function reidentify(node: WorkflowNode, used: Set<string>): void {
  (node as { id: string }).id = crypto.randomUUID();
  (node as { name: string }).name = uniqueName(`${node.name}-copy`, used);
  for (const child of childBodies(node)) {
    for (const childNode of child.nodes) reidentify(childNode, used);
  }
}

/** The names already used anywhere in a body, for a caller minting a file-unique new name. */
export function usedNames(body: WorkflowNode[]): Set<string> {
  const names = new Set<string>();
  const visit = (nodes: WorkflowNode[]): void => {
    for (const node of nodes) {
      names.add(node.name);
      for (const child of childBodies(node)) visit(child.nodes);
    }
  };
  visit(body);
  return names;
}
