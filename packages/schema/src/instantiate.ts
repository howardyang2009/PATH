import type { WorkflowNode } from "./node-type.js";
import { childBodies } from "./node-walk.js";
import type { WorkflowFile } from "./workflow-file-type.js";

/** **Instantiation** (ADR 0049): the pure transform turning a Step-Template body into ordinary
 * workflow nodes — deep-copy, re-stamp every `id`, copy data verbatim, uniquify names, wrap 2+ for a slot. */
export interface InstantiateOptions {
  /** Names already in use in the target, so a colliding name is uniquified. Defaults to none. */
  usedNames?: Iterable<string>;
  /** The drop target's shape. `"single"` is a single-node slot (a `while-do` body, a branch arm, an
   * `else`); `"list"` (the default) splices any count directly. */
  socket?: "list" | "single";
}

/** A free name derived from `base`: `base`, then `base-2`, `base-3`, … until one is unused. Reserves it. */
export function uniqueName(base: string, used: Set<string>): string {
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

/** Re-stamps a cloned node in place: fresh id, name verbatim unless taken. Pre-order, so a node's own
 * name is reserved before its children's — the deterministic order ADR 0049 fixes. */
function restamp(node: WorkflowNode, used: Set<string>): void {
  (node as { id: string }).id = crypto.randomUUID();
  (node as { name: string }).name = uniqueName(node.name, used);
  for (const child of childBodies(node)) {
    for (const childNode of child.nodes) restamp(childNode, used);
  }
}

export function instantiate(
  body: WorkflowNode[],
  options: InstantiateOptions = {},
): WorkflowNode[] {
  const used = new Set(options.usedNames ?? []);
  const nodes = structuredClone(body) as WorkflowNode[];
  for (const node of nodes) restamp(node, used);

  // A 2+-node body cannot occupy a single-node slot as-is (ADR 0014 / `@2` §4.3); wrap it in a `sequence`.
  if (options.socket === "single" && nodes.length >= 2) {
    return [
      {
        type: "sequence",
        id: crypto.randomUUID(),
        name: uniqueName("sequence", used),
        body: nodes,
      },
    ];
  }
  return nodes;
}

/** Whole-workflow copy: {@link instantiate} over the body plus a fresh workflow `id` — two workflows
 * must not share a source-workflow identity (ADR 0006). Every other field rides across verbatim. */
export function instantiateWorkflow(template: WorkflowFile): WorkflowFile {
  const file = structuredClone(template);
  return { ...file, id: crypto.randomUUID(), body: instantiate(file.body) };
}
