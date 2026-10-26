import { type Message, verbatim } from "@path/i18n";

/**
 * Every Designer fact about one node kind, in one table: canvas hue, palette label and blurb, pane
 * explanation, leaf chip and glyph, the required field a new leaf is stubbed with, and whether a
 * hand-built editor exists. The canvas, palette, pane and node factory all read `nodeKind`. An
 * unlisted (registry) leaf type takes the step defaults.
 */
export interface NodeKind {
  /** Hue-token stem: the block tints from `--k-<hue>` / `--k-<hue>-bg`. */
  hue: string;
  label: Message;
  /** The palette card's short line. */
  blurb: Message;
  /** The pane's one-line explanation, shown above the divider. */
  explanation: Message;
  /** The leaf chip text, English in every Locale: it is the `type` the author writes. */
  chip: string;
  /** The glyph drawn before the chip, or `""`. */
  glyph: string;
  /** The type field a fresh leaf carries empty, for the pane to fill; `null` stubs none. */
  stubField: string | null;
  /** A hand-built pane editor exists; `binary` has none, the generic form lays it out (ADR 0018). */
  firstClass: boolean;
}

/** The catalogue name under `designer.nodeKind` that holds a kind's label, blurb and explanation. */
type KindName =
  | "prompt"
  | "binary"
  | "personActivity"
  | "workflow"
  | "parallel"
  | "branch"
  | "whileDo"
  | "sequence"
  | "checkpoint"
  | "goto";

type KindEntry = { name: KindName; hue: string } & Partial<
  Pick<NodeKind, "chip" | "glyph" | "stubField" | "firstClass">
>;

const KIND: Record<string, KindEntry> = {
  prompt: {
    name: "prompt",
    hue: "step",
    chip: "LLM",
    stubField: "prompt",
    firstClass: true,
  },
  binary: {
    name: "binary",
    hue: "step",
    chip: "COMMAND",
    stubField: "command",
  },
  "person-activity": {
    name: "personActivity",
    hue: "person",
    chip: "PERSON",
    glyph: "👤",
    stubField: "description",
    firstClass: true,
  },
  workflow: {
    name: "workflow",
    hue: "workflow",
    stubField: "ref",
    firstClass: true,
  },
  parallel: {
    name: "parallel",
    hue: "parallel",
  },
  branch: {
    name: "branch",
    hue: "branch",
  },
  "while-do": {
    name: "whileDo",
    hue: "while",
  },
  sequence: {
    name: "sequence",
    hue: "sequence",
  },
  checkpoint: {
    name: "checkpoint",
    hue: "checkpoint",
  },
  goto: {
    name: "goto",
    hue: "goto",
  },
};

function titleCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The facts for a node `type`, defaults filled in; an unlisted type's label is its own name. */
export function nodeKind(type: string): NodeKind {
  const entry = KIND[type];
  const name = entry?.name;
  return {
    hue: entry?.hue ?? "step",
    label: name ? { key: `designer.nodeKind.${name}.label` } : verbatim(titleCase(type)),
    blurb: name
      ? { key: `designer.nodeKind.${name}.blurb` }
      : { key: "designer.nodeKind.step.blurb", params: { type } },
    explanation: name
      ? { key: `designer.nodeKind.${name}.explanation` }
      : { key: "designer.nodeKind.step.explanation", params: { type } },
    chip: entry?.chip ?? type.toUpperCase(),
    glyph: entry?.glyph ?? "",
    stubField: entry?.stubField ?? null,
    firstClass: entry?.firstClass ?? false,
  };
}
