/**
 * Every Designer fact about one node kind, in one table: canvas hue, palette label and blurb, pane
 * explanation, leaf chip and glyph, the required field a new leaf is stubbed with, and whether a
 * hand-built editor exists. The canvas, palette, pane and node factory all read `nodeKind`. An
 * unlisted (registry) leaf type takes the step defaults.
 */
export interface NodeKind {
  /** Hue-token stem: the block tints from `--k-<hue>` / `--k-<hue>-bg`. */
  hue: string;
  label: string;
  /** The palette card's short line. */
  blurb: string;
  /** The pane's one-line explanation, shown above the divider. */
  explanation: string;
  /** The leaf chip text. */
  chip: string;
  /** The glyph drawn before the chip, or `""`. */
  glyph: string;
  /** The type field a fresh leaf carries empty, for the pane to fill; `null` stubs none. */
  stubField: string | null;
  /** A hand-built pane editor exists; `binary` has none, the generic form lays it out (ADR 0018). */
  firstClass: boolean;
}

type KindEntry = Pick<NodeKind, "hue" | "blurb" | "explanation"> & Partial<NodeKind>;

const KIND: Record<string, KindEntry> = {
  prompt: {
    hue: "step",
    blurb: "LLM prompt against a model",
    explanation: "An LLM prompt run against a model.",
    chip: "LLM",
    stubField: "prompt",
    firstClass: true,
  },
  binary: {
    hue: "step",
    blurb: "A command with args and cwd",
    explanation: "A command run with arguments in a working directory.",
    chip: "COMMAND",
    stubField: "command",
  },
  "person-activity": {
    hue: "person",
    blurb: "An offline activity a person completes",
    explanation: "An offline activity a person completes; the run awaits their Complete.",
    chip: "PERSON",
    glyph: "👤",
    stubField: "description",
    firstClass: true,
  },
  workflow: {
    hue: "workflow",
    blurb: "A sub-workflow reference",
    explanation: "A reference to another workflow file, run as a nested run.",
    stubField: "ref",
    firstClass: true,
  },
  parallel: {
    hue: "parallel",
    blurb: "Branches with a join mode",
    explanation: "Runs its branches together; the join mode decides how their outputs land.",
  },
  branch: {
    hue: "branch",
    blurb: "First-match arms with an else",
    explanation: "First-match-wins arms, each guarded by a condition, with an optional else.",
  },
  "while-do": {
    hue: "while",
    label: "While-do",
    blurb: "A bounded loop over one body",
    explanation: "Repeats one body while a condition holds, up to a maximum count.",
  },
  sequence: {
    hue: "sequence",
    blurb: "An ordered stack of nodes",
    explanation: "An ordered stack of nodes, run one after another.",
  },
  checkpoint: {
    hue: "checkpoint",
    blurb: "An assertion on the run",
    explanation: "Asserts a condition on the run; a failed assertion fails the run.",
  },
  goto: {
    hue: "goto",
    blurb: "A bounded jump to a first-level node",
    explanation: "Jumps back or ahead to a first-level node, at most max jumps times.",
  },
};

function titleCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The facts for a node `type`, defaults filled in. */
export function nodeKind(type: string): NodeKind {
  const entry = KIND[type];
  return {
    hue: entry?.hue ?? "step",
    label: entry?.label ?? titleCase(type),
    blurb: entry?.blurb ?? `A ${type} step`,
    explanation: entry?.explanation ?? `A ${type} step.`,
    chip: entry?.chip ?? type.toUpperCase(),
    glyph: entry?.glyph ?? "",
    stubField: entry?.stubField ?? null,
    firstClass: entry?.firstClass ?? false,
  };
}
