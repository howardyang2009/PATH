/**
 * Per-kind presentation facts — canvas hue, pane explanation, leaf chip glyph — read by the canvas block
 * render and the properties pane, so a kind is described once. An unlisted leaf type takes step defaults.
 */

/** The kind-specific presentation facts. A kind not listed falls back to the step defaults below. */
interface KindDescriptor {
  /** Hue-token stem: the block tints from `--k-<hue>` / `--k-<hue>-bg`. */
  hue: string;
  explanation: string;
  glyph?: string;
}

const KIND: Record<string, KindDescriptor> = {
  prompt: { hue: "step", explanation: "An LLM prompt run against a model." },
  binary: { hue: "step", explanation: "A command run with arguments in a working directory." },
  // A `person-activity` carries its own teal hue and glyph; the run awaits the person's Complete.
  "person-activity": {
    hue: "person",
    explanation: "An offline activity a person completes; the run awaits their Complete.",
    glyph: "👤",
  },
  workflow: {
    hue: "workflow",
    explanation: "A reference to another workflow file, run as a nested run.",
  },
  parallel: {
    hue: "parallel",
    explanation: "Runs its branches together; the join mode decides how their outputs land.",
  },
  branch: {
    hue: "branch",
    explanation: "First-match-wins arms, each guarded by a condition, with an optional else.",
  },
  "while-do": {
    hue: "while",
    explanation: "Repeats one body while a condition holds, up to a maximum count.",
  },
  sequence: { hue: "sequence", explanation: "An ordered stack of nodes, run one after another." },
  checkpoint: {
    hue: "checkpoint",
    explanation: "Asserts a condition on the run; a failed assertion fails the run.",
  },
  goto: {
    hue: "goto",
    explanation: "Jumps back or ahead to a first-level node, at most max jumps times.",
  },
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
  if (type === "person-activity") return "PERSON";
  return type.toUpperCase();
}

/** The leaf glyph a kind draws before its chip, or `""` when it has none. */
export function leafGlyph(type: string): string {
  return KIND[type]?.glyph ?? "";
}
