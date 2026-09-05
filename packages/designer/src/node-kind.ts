/**
 * The flat, per-kind presentation facts of a node kind — its canvas hue, its one-line pane explanation,
 * and its leaf chip label — gathered in one table (#369). The canvas block render (`block-tree.tsx`) and
 * the properties pane (`properties-pane.tsx`) both read from here, so the same kind is described once
 * rather than switched over in each. The render and edit *dispatch* (which JSX a kind draws, which fields
 * it edits) stays in those files — this module holds only the flat facts, not the markup.
 *
 * A leaf step type outside the fixed set (a registry plugin like `api-call`) has no descriptor row: it
 * takes the shared **step** hue, an explanation derived from its type name, and its upper-cased type as
 * the chip. So the table lists only the kinds with kind-specific copy, and the accessors fall back for
 * every other type.
 */

/** The kind-specific presentation facts. A kind not listed falls back to the step defaults below. */
interface KindDescriptor {
  /** The hue-token stem (`--k-<hue>` / `--k-<hue>-bg`) the canvas block tints from. */
  hue: string;
  /** The one-line explanation shown above the pane divider (§ Pane layout, explanatory copy). */
  explanation: string;
}

const KIND: Record<string, KindDescriptor> = {
  prompt: { hue: "step", explanation: "An LLM prompt run against a model." },
  binary: { hue: "step", explanation: "A command run with arguments in a working directory." },
  workflow: { hue: "workflow", explanation: "A reference to another workflow file, run as a nested run." },
  parallel: { hue: "parallel", explanation: "Runs its branches together; the join mode decides how their outputs land." },
  branch: { hue: "branch", explanation: "First-match-wins arms, each guarded by a condition, with an optional else." },
  "while-do": { hue: "while", explanation: "Repeats one body while a condition holds, up to a maximum count." },
  sequence: { hue: "sequence", explanation: "An ordered stack of nodes, run one after another." },
  checkpoint: { hue: "checkpoint", explanation: "Asserts a condition on the run; a failed assertion fails the run." },
};

/** The hue-token stem for a node type. A leaf step and any unlisted (registry) type share the step hue. */
export function nodeHue(type: string): string {
  return KIND[type]?.hue ?? "step";
}

/** The one-line explanation of a node kind, shown above the divider. An unlisted type reads as a step. */
export function kindExplanation(type: string): string {
  return KIND[type]?.explanation ?? `A ${type} step.`;
}

/** The chip label for a leaf step: `LLM` for a prompt, `COMMAND` for a binary, else the type upper-cased. */
export function leafChip(type: string): string {
  if (type === "prompt") return "LLM";
  if (type === "binary") return "COMMAND";
  return type.toUpperCase();
}
