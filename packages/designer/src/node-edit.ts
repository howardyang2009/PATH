import { ENVELOPE_KEYS, type ConfigObject, type WorkflowNode } from "@path/schema";

/**
 * The pure **content** edits the properties pane performs on a single `WorkflowNode` (#369) — the
 * counterpart of `edit-tree.ts`, which does the **structure** edits on the file body. Every function
 * here takes a node and returns a **new** node; none touches the tree spine or a node's position. The
 * pane composes these with `edit-tree.replaceNode` to land a content edit in place.
 *
 * A `WorkflowNode` is a closed discriminated union with no index signature, so a payload read or write
 * has to view the node as an open record. `rec` is that **one** cast — the single boundary where the
 * union is opened — so the rest of the module (and the pane) reads and writes payload keys through typed
 * helpers rather than scattering the cast. `nodePayload` / `mergeNodePayload` split the node at the
 * identity/control **envelope** — `ENVELOPE_KEYS`, owned by `@path/schema` where the node shape is
 * defined, so a new envelope field never drifts a hand-kept copy here.
 */

/** A node as an open record — the discriminated union carries no index signature, so every payload read goes through here. */
export function rec(node: WorkflowNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

/** The node's payload — every key outside the identity/control envelope (what the raw-JSON floor edits). */
export function nodePayload(node: WorkflowNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!ENVELOPE_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** Rebuild a node from its envelope plus a fresh payload (envelope keys in the payload are ignored). */
export function mergeNodePayload(node: WorkflowNode, payload: Record<string, unknown>): WorkflowNode {
  const envelope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (ENVELOPE_KEYS.has(key)) envelope[key] = value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ENVELOPE_KEYS.has(key)) cleaned[key] = value;
  }
  return { ...envelope, ...cleaned } as unknown as WorkflowNode;
}

/** Set a payload/envelope key on a node (an `undefined` value drops the key), returning a new node. */
export function setNodeField(node: WorkflowNode, key: string, value: unknown): WorkflowNode {
  if (value === undefined) return dropNodeKey(node, key);
  return { ...node, [key]: value } as WorkflowNode;
}

/** Drop a key from a node, returning a new node without it. */
export function dropNodeKey(node: WorkflowNode, key: string): WorkflowNode {
  const { [key]: _dropped, ...rest } = rec(node);
  return rest as unknown as WorkflowNode;
}

/** An optional string field: set it when non-empty, drop it when empty. */
export function withOptionalString(node: WorkflowNode, key: string, value: string): WorkflowNode {
  return value === "" ? dropNodeKey(node, key) : setNodeField(node, key, value);
}

/** An optional array field: set it when non-empty, drop it when empty. */
export function withOptionalArray(node: WorkflowNode, key: string, value: string[]): WorkflowNode {
  return value.length === 0 ? dropNodeKey(node, key) : setNodeField(node, key, value);
}

/** The node's own `config` object, or `undefined` when it carries none. */
export function nodeConfigOf(node: WorkflowNode): ConfigObject | undefined {
  const config = rec(node).config;
  return config !== null && typeof config === "object" && !Array.isArray(config) ? (config as ConfigObject) : undefined;
}

/** Write (or drop) a node's `config`, keeping the node otherwise intact. */
export function applyNodeConfig(node: WorkflowNode, config: ConfigObject | undefined): WorkflowNode {
  return config === undefined ? dropNodeKey(node, "config") : ({ ...node, config } as WorkflowNode);
}

/**
 * Read a string payload/envelope datum off a node (`prompt`, `command`, `cwd`, `ref`, `parse`,
 * `worker`), or `""` when the key is absent or non-string. The one string-payload read the first-class
 * editors share, so each stops re-spelling `typeof rec(node).x === "string" ? … : ""` and the `rec` cast
 * stays here at the module's single open-record boundary.
 */
export function nodeString(node: WorkflowNode, key: string): string {
  const value = rec(node)[key];
  return typeof value === "string" ? value : "";
}

/** Read a string config datum off a node (e.g. `prompt`'s `model`), or `""` when absent. */
export function configString(node: WorkflowNode, key: string): string {
  return configStringOf(rec(node).config as Record<string, unknown> | undefined, key);
}

/** Read a string value off a config object (a node's or the file's), or `""` when absent or non-string. */
export function configStringOf(config: Record<string, unknown> | undefined, key: string): string {
  const value = config?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Write a string config datum on a node, dropping the key (and an emptied `config`) when cleared. This
 * is the single-key config touch #369 owns — the `model` line named in the spec's prompt editor. The
 * full inherited-vs-overridden config editor (§ Config inheritance display) uses `config-inheritance.ts`.
 */
export function withConfig(node: WorkflowNode, key: string, value: string): WorkflowNode {
  const config: Record<string, unknown> = { ...((rec(node).config as Record<string, unknown> | undefined) ?? {}) };
  if (value === "") delete config[key];
  else config[key] = value;
  if (Object.keys(config).length === 0) return dropNodeKey(node, "config");
  return { ...node, config } as WorkflowNode;
}
