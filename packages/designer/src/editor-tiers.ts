import type { WireFieldSpec, WireStepPlugin } from "@path/client-core";
import { nodeKind } from "./node-kind.js";

/** Editor tiers — a hand-built editor, the registry-driven generic form, else the JSON floor. */
export type EditorTier = "first-class" | "generic" | "raw-json";

/** Does the generic form lay out a control? Only scalars and flat arrays of scalars do. */
function fieldLaysOut(field: WireFieldSpec): boolean {
  if (field.type === "string" || field.type === "number" || field.type === "boolean") return true;
  if (field.type === "array" && field.element) {
    const el = field.element.type;
    return el === "string" || el === "number" || el === "boolean";
  }
  return false;
}

/** Every field of the fragment lays out, so the generic form can render the whole type. */
export function fieldsLayOut(fields: Record<string, WireFieldSpec>): boolean {
  return Object.values(fields).every(fieldLaysOut);
}

/** The registry entry for a leaf `type`, or `undefined` for `workflow` / an off-registry type. */
export function pluginFor(type: string, plugins: WireStepPlugin[]): WireStepPlugin | undefined {
  return plugins.find((p) => p.name === type);
}

/** Resolve the tier for a leaf `type`; an off-registry leaf falls to the JSON floor (ADR 0026). */
export function editorTier(type: string, plugins: WireStepPlugin[]): EditorTier {
  if (nodeKind(type).firstClass) return "first-class";
  const plugin = pluginFor(type, plugins);
  // an off-registry leaf never reaches an open file (ADR 0026); defensive.
  if (!plugin) return "raw-json";
  return fieldsLayOut(plugin.fields) ? "generic" : "raw-json";
}
