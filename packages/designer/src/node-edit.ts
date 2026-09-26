import { type ConfigObject, ENVELOPE_KEYS, type WorkflowNode } from "@path/schema";
import { withoutKey } from "./edit-target.js";

/**
 * The pure **content** edits the pane performs on one `WorkflowNode` (the counterpart of `edit-tree.ts`'s
 * structure edits); each returns a new node and none touches the spine. `rec` opens the closed union.
 */

/** A node as an open record — the discriminated union carries no index signature. */
export function rec(node: WorkflowNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

/** The node's payload — every key outside the identity/control envelope. */
export function nodePayload(node: WorkflowNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!ENVELOPE_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** Rebuild a node from its envelope plus a fresh payload (envelope keys in the payload are ignored). */
export function mergeNodePayload(
  node: WorkflowNode,
  payload: Record<string, unknown>,
): WorkflowNode {
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
  return withoutKey(node, key);
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
  return config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as ConfigObject)
    : undefined;
}

/** Write (or drop) a node's `config`, keeping the node otherwise intact. */
export function applyNodeConfig(
  node: WorkflowNode,
  config: ConfigObject | undefined,
): WorkflowNode {
  return config === undefined ? dropNodeKey(node, "config") : ({ ...node, config } as WorkflowNode);
}

/** Read a string payload/envelope datum off a node, or `""` when the key is absent or non-string. */
export function nodeString(node: WorkflowNode, key: string): string {
  const value = rec(node)[key];
  return typeof value === "string" ? value : "";
}

/** Read a string config datum off a node (e.g. `prompt`'s `model`), or `""` when absent. */
export function configString(node: WorkflowNode, key: string): string {
  return configStringOf(rec(node).config as Record<string, unknown> | undefined, key);
}

/** Read a string value off a config object (a node's or the file's), or `""` when absent. */
export function configStringOf(config: Record<string, unknown> | undefined, key: string): string {
  const value = config?.[key];
  return typeof value === "string" ? value : "";
}

/** Write a string config datum on a node, dropping the key (and an emptied `config`) when cleared. */
export function withConfig(node: WorkflowNode, key: string, value: string): WorkflowNode {
  const config: Record<string, unknown> = {
    ...((rec(node).config as Record<string, unknown> | undefined) ?? {}),
  };
  if (value === "") delete config[key];
  else config[key] = value;
  if (Object.keys(config).length === 0) return dropNodeKey(node, "config");
  return { ...node, config } as WorkflowNode;
}
