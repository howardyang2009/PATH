import type { Condition, WorkflowNode } from "@path/schema";
import { childBodies, uniqueName } from "@path/schema";

/**
 * Minting new nodes for the canvas (designer-spec § Adding; ADR 0015): every node carries a client-minted
 * UUIDv4 `id` and a file-unique `name`, and a block is born with its minimal legal occupants pre-filled
 * by a default leaf. A name handed out is added to `used`, so a block and its occupants never collide.
 */

/** A default placeholder condition for a new `branch` arm, `while-do`, or `checkpoint`; edited later. */
function defaultCondition(): Condition {
  return { type: "exists", path: "context.value" };
}

/** A fresh leaf of `type`, with the type's own required field stubbed empty for the pane to fill. */
function makeLeaf(type: string, used: Set<string>): WorkflowNode {
  const base = { id: crypto.randomUUID(), name: uniqueName(type, used), type };
  switch (type) {
    case "prompt":
      return { ...base, prompt: "" } as WorkflowNode;
    case "binary":
      return { ...base, command: "" } as WorkflowNode;
    case "workflow":
      return { ...base, ref: "" } as WorkflowNode;
    case "person-activity":
      // Its `description` is the required field; the cast is needed because a plugin leaf sits outside
      // the core node union.
      return { ...base, description: "" } as unknown as WorkflowNode;
    default:
      // A generic registry leaf (e.g. `api-call`): only the envelope is minted; the engine tolerates the
      // empty payload, so no field is stubbed here.
      return base as unknown as WorkflowNode;
  }
}

/**
 * A fresh node of `kind`, ready to place. A leaf kind makes a leaf; a block makes its shell with a
 * default leaf occupant (`defaultLeaf`, the palette's first Steps entry, else `prompt`) in each slot.
 */
export function createNode(kind: string, used: Set<string>, defaultLeaf = "prompt"): WorkflowNode {
  switch (kind) {
    case "sequence":
      return {
        id: crypto.randomUUID(),
        name: uniqueName("sequence", used),
        type: "sequence",
        body: [makeLeaf(defaultLeaf, used)],
      };
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
      return {
        id: crypto.randomUUID(),
        name: uniqueName("checkpoint", used),
        type: "checkpoint",
        condition: defaultCondition(),
      };
    case "goto":
      // Born pointing nowhere (`""`): the pane shows it as `missing:` until the author picks one, and
      // `max_jumps` is mandatory (designer-spec § goto).
      return {
        id: crypto.randomUUID(),
        name: uniqueName("goto", used),
        type: "goto",
        target: "",
        max_jumps: 3,
      };
    default:
      return makeLeaf(kind, used);
  }
}

/** A fresh `branch` arm — a default `when` over a default leaf occupant — for the add-arm affordance. */
export function createArm(
  used: Set<string>,
  defaultLeaf = "prompt",
): { when: Condition; node: WorkflowNode } {
  return { when: defaultCondition(), node: makeLeaf(defaultLeaf, used) };
}

/**
 * A deep clone with fresh identity throughout: new UUIDv4 `id`s and `-copy` names; a copy is never an alias (ADR
 * 0015).
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
