import { childBodies } from "./node-walk.js";
import type { WorkflowNode } from "./node-type.js";
import type { WorkflowFile } from "./workflow-file-type.js";

/**
 * **Instantiation** (ADR 0049): the pure transform that turns a Step-Template body into ordinary
 * workflow nodes. It is owned by `@path/schema` and called by the Designer with no engine or server in
 * the loop — the engine is blind to templates and the Server only serves the bytes; the client mints
 * ids (ADR 0015). A `WorkflowNode[]` goes in and a fresh, deep-copied `WorkflowNode[]` comes out, a
 * fragment indistinguishable from a hand-authored one.
 *
 * What it does, and only this:
 *
 * 1. **Deep-copy** the body — the source is never mutated.
 * 2. **Re-stamp every id** with a fresh `crypto.randomUUID()`, recursively: leaf steps, container
 *    nodes, every branch arm and `else`, every `parallel` branch (each carries its own `id`, `@2`
 *    §4.3). The template's envelope `id` is a caller concern and is not part of the body, so nothing
 *    here copies it into the workflow.
 * 3. **Copy every other datum verbatim** — values, `config`, `parse`, `publish`, `condition`, and each
 *    `workflow` `ref`. No reference is rewired: a `@2` body fragment holds no GUID cross-references
 *    (#559), so its intra-body wiring is value-level or name-level and stays consistent after a copy
 *    that touched only ids.
 * 4. **Names verbatim until collision, then uniquified** the way any new node's name is — `name`, then
 *    `name-2`, `name-3`, … — against the target file's names plus the names already assigned earlier in
 *    the same insert (deterministic pre-order). No `-copy` suffix: an instance is not a duplicate of any
 *    node the file already holds (contrast `node-factory.ts`'s `cloneWithFreshIdentity`).
 * 5. **Insert socket.** A 2+-node body dropped into a single-node container slot (a `while-do` body, a
 *    branch arm, an `else`) is wrapped in a fresh `sequence`; a one-node body inserts bare; a list slot
 *    (the file body top level or an existing `sequence`) splices the nodes in directly.
 *
 * No defaults pass, no rewiring pass: a template's default values *are* the values its nodes hold (ADR
 * 0048), and the engine supplies type/worker/config defaults at run time against the live registry.
 */
export interface InstantiateOptions {
  /**
   * The names already in use in the target — the target file's node names — so a colliding name is
   * uniquified. Copied into a private set, so a caller's set is never mutated. Defaults to none.
   */
  usedNames?: Iterable<string>;
  /**
   * The drop target's grammar shape. `"single"` is a single-node slot (a `while-do` body, a branch
   * arm, an `else`): a 2+-node body is wrapped in a fresh `sequence`. `"list"` (the default) is the
   * file body top level or an existing `sequence`: the nodes splice in directly, any count.
   */
  socket?: "list" | "single";
}

/** A free name derived from `base`: `base`, then `base-2`, `base-3`, … until one is unused. Reserves it. */
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

/**
 * Re-stamp a cloned node in place: a fresh id, and a name kept verbatim unless it collides with one in
 * `used`. Descends the block grammar via `childBodies` — the one statement of the descent — so a node
 * type added to the format is re-stamped here without a second edit. Pre-order: a node's own name is
 * reserved before its children's, the deterministic order ADR 0049 decision 5 fixes.
 */
function restamp(node: WorkflowNode, used: Set<string>): void {
  (node as { id: string }).id = crypto.randomUUID();
  (node as { name: string }).name = uniqueName(node.name, used);
  for (const child of childBodies(node)) {
    for (const childNode of child.nodes) restamp(childNode, used);
  }
}

export function instantiate(body: WorkflowNode[], options: InstantiateOptions = {}): WorkflowNode[] {
  const used = new Set(options.usedNames ?? []);
  const nodes = structuredClone(body) as WorkflowNode[];
  for (const node of nodes) restamp(node, used);

  // A 2+-node body cannot occupy a single-node slot as-is (ADR 0014 / `@2` §4.3); wrap it in a fresh
  // `sequence` so the drop is grammar-legal. A one-node body needs no wrapper, and a list slot takes
  // any count directly.
  if (options.socket === "single" && nodes.length >= 2) {
    return [{ type: "sequence", id: crypto.randomUUID(), name: uniqueName("sequence", used), body: nodes }];
  }
  return nodes;
}

/**
 * **Whole-workflow instantiation**, the Designer's workflow-mode Save as… Workflow copy: the same detached
 * copy over the whole workflow, plus a **workflow-level re-mint**. The source's workflow `id` is its own
 * identity, so the copy gets a fresh one — two workflows must not share a source-workflow identity (ADR
 * 0006). Every node id is re-stamped by {@link instantiate}; the copy is a whole file, so no name collides
 * and every name stays verbatim. Everything else — `name`, `input`, `worker_defaults`, `config`, `output`
 * — rides across verbatim as a deep copy; the saved name/path come from the save-as dialog, not from here.
 */
export function instantiateWorkflow(template: WorkflowFile): WorkflowFile {
  const file = structuredClone(template);
  return { ...file, id: crypto.randomUUID(), body: instantiate(file.body) };
}
