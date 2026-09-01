import type { WireFieldSpec, WireStepPlugin } from "@path/client-core";

/**
 * The three-tier editor resolution (#369, designer-spec § Editors: first-class, generic, and the
 * raw-JSON floor). Every in-registry leaf step type opens; the tiers form a total order so the worst
 * case is a validated JSON box, never a blocked node (ADR 0026, ADR 0018).
 *
 * - **first-class** — `prompt`, `binary`, `workflow`: hand-built editors elsewhere.
 * - **generic** — any other registry type whose every field a form can lay out: a control per field.
 * - **raw-json** — any type with a field a form cannot lay out: one live-validated JSON textarea.
 *
 * `workflow` is not a registry plugin (it is grammar-fixed, § The palette is registry-driven) but it
 * still resolves first-class here, so a single call decides the tier for any leaf `type`.
 */
export type EditorTier = "first-class" | "generic" | "raw-json";

/** The three leaf types with a hand-built editor (§ Editors, first row). */
const FIRST_CLASS = new Set(["prompt", "binary", "workflow"]);

/**
 * Can the generic form lay out a control for this field? Scalars (`string`, `number`, `boolean`) and a
 * flat array of scalars lay out; a `record`, `object`, `unknown`, or a nested container does not, and
 * drops the whole type to the raw-JSON floor. Keeping the layoutable set to scalars-and-flat-arrays is
 * the honest floor the spec draws: fidelity degrades to JSON rather than a form guessing at a shape.
 */
function fieldLaysOut(field: WireFieldSpec): boolean {
  if (field.type === "string" || field.type === "number" || field.type === "boolean") return true;
  if (field.type === "array" && field.element) {
    const el = field.element.type;
    return el === "string" || el === "number" || el === "boolean";
  }
  return false;
}

/** Every field of a type's `fields` fragment lays out as a control (so the generic form is honest). */
export function fieldsLayOut(fields: Record<string, WireFieldSpec>): boolean {
  return Object.values(fields).every(fieldLaysOut);
}

/** The registry entry for a leaf `type`, or `undefined` for `workflow` / an off-registry type. */
export function pluginFor(type: string, plugins: WireStepPlugin[]): WireStepPlugin | undefined {
  return plugins.find((p) => p.name === type);
}

/** Resolve the editor tier for a leaf step `type` against the received registry. */
export function editorTier(type: string, plugins: WireStepPlugin[]): EditorTier {
  if (FIRST_CLASS.has(type)) return "first-class";
  const plugin = pluginFor(type, plugins);
  if (!plugin) return "raw-json"; // an off-registry leaf never reaches an open file (ADR 0026); defensive.
  return fieldsLayOut(plugin.fields) ? "generic" : "raw-json";
}
