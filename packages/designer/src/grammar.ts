import { childBodies, type WorkflowNode, walkNodes } from "@path/schema";

/**
 * The block grammar as the canvas enforces it (designer-spec § Canvas interaction model): a block is
 * unsnappable where the grammar refuses it, rather than rejected on save. `checkpoint` is legal only in a
 * `sequence` list (CONTEXT.md § Composition), and a `goto` may not sit under a `while-do` or a `parallel`
 * at any depth, so a socket may be **barred**.
 */

/** A socket's shape: an ordered list, a single-node slot, or a `parallel` branch list. */
export type SocketFlavor = "sequence" | "single" | "branches";

/**
 * The six controller kinds fixed by the grammar, five Structure Controllers and the one Graph Controller `goto` (ADR
 * 0057).
 */
export const CONTROLLER_KINDS = [
  "parallel",
  "branch",
  "while-do",
  "sequence",
  "checkpoint",
  "goto",
] as const;
export type ControllerKind = (typeof CONTROLLER_KINDS)[number];

/** Is `kind` legal in a socket of `flavor`? `checkpoint` only in a `sequence` list, `goto` only unbarred. */
export function socketAcceptsKind(flavor: SocketFlavor, kind: string, barred = false): boolean {
  if (kind === "checkpoint") return flavor === "sequence";
  if (kind === "goto") return !barred;
  return true;
}

/**
 * Does `ownerId`'s socket sit under a `while-do` or a `parallel` (the owner itself counts)? This is the chain the
 * goto placement rule reads.
 */
export function socketBarred(body: readonly WorkflowNode[], ownerId: string | null): boolean {
  if (ownerId === null) return false;
  const visit = (nodes: readonly WorkflowNode[], barred: boolean): boolean | null => {
    for (const node of nodes) {
      const inner = barred || node.type === "while-do" || node.type === "parallel";
      if (node.id === ownerId) return inner;
      for (const child of childBodies(node)) {
        const found = visit(child.nodes, inner);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return visit(body, false) ?? false;
}

/**
 * How a Template body lands, as `instantiate`'s socket option: a list splices, anything else wraps 2+ nodes in a
 * `sequence` (ADR 0049).
 */
export function bodyInsertSocket(flavor: SocketFlavor): "list" | "single" {
  return flavor === "sequence" ? "list" : "single";
}

/** Is a Template `body` legal here? An empty body places nothing; a barred socket refuses a goto in it. */
export function socketAcceptsBody(
  flavor: SocketFlavor,
  body: readonly WorkflowNode[],
  barred = false,
): boolean {
  if (body.length === 0) return false;
  if (barred && [...walkNodes([...body])].some((node) => node.type === "goto")) return false;
  if (bodyInsertSocket(flavor) === "list")
    return body.every((node) => socketAcceptsKind(flavor, node.type));
  return body.length >= 2 || socketAcceptsKind(flavor, body[0]!.type);
}

/**
 * Does a node of `type` carry the step envelope (`config`/`input`/`parse`/`publish`)? Exactly "not a controller
 * kind".
 */
export function carriesEnvelope(type: string): boolean {
  return !(CONTROLLER_KINDS as readonly string[]).includes(type);
}

/** The flavour a node's own child slots expose, for a caller placing into an existing block. */
export function childSocketFlavor(node: WorkflowNode): SocketFlavor | null {
  switch (node.type) {
    case "sequence":
      return "sequence";
    case "parallel":
      return "branches";
    case "while-do":
      return "single";
    case "branch":
      return "single"; // both an arm occupant and `else` are single slots
    default:
      return null; // leaves, `checkpoint`, `goto` and `workflow` nest nothing inline
  }
}
