import type { WireStepPlugin } from "@path/client-core";

/**
 * The palette's categories, split across the two rail tabs. The **Nodes** tab: **Step** — one
 * registry-driven entry per leaf step type (the `workflow` ref included) — and **Controller**, fixed by
 * the grammar and split into Structure | Graph. The **Templates** tab: one card per `GET /v0/templates`
 * entry, with no group heading (one kind only, ADR 0063).
 */
export interface PaletteEntry {
  readonly kind: string;
  /** The palette label shown to the author. */
  readonly label: string;
  readonly blurb: string;
  /** Hue token key when it differs from `kind` (a `while-do` block paints the `while` hue). */
  readonly hue: string;
}

export interface PaletteGroup {
  readonly title: string;
  readonly entries: readonly PaletteEntry[];
  /** Sub-tabs that split `entries` for display (the Controller group: Structure | Graph). */
  readonly tabs?: readonly PaletteSubTab[];
}

export interface PaletteSubTab {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly PaletteEntry[];
}

function titleCase(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

function leafBlurb(name: string): string {
  if (name === "prompt") return "LLM prompt against a model";
  if (name === "binary") return "A command with args and cwd";
  if (name === "person-activity") return "An offline activity a person completes";
  return `A ${name} step`;
}

function stepGroup(plugins: WireStepPlugin[]): PaletteGroup {
  const fromRegistry: PaletteEntry[] = plugins.map((plugin) => ({
    kind: plugin.name,
    label: titleCase(plugin.name),
    blurb: leafBlurb(plugin.name),
    hue: "step",
  }));
  const workflowRef: PaletteEntry = {
    kind: "workflow",
    label: "Workflow",
    blurb: "A sub-workflow reference",
    hue: "workflow",
  };
  return { title: "Step", entries: [...fromRegistry, workflowRef] };
}

/** The five Structure Controllers, checkpoint included, fixed by the grammar (§ What is authorable). */
const STRUCTURE_CONTROLLERS: readonly PaletteEntry[] = [
  { kind: "parallel", label: "Parallel", blurb: "Branches with a join mode", hue: "parallel" },
  { kind: "branch", label: "Branch", blurb: "First-match arms with an else", hue: "branch" },
  { kind: "while-do", label: "While-do", blurb: "A bounded loop over one body", hue: "while" },
  { kind: "sequence", label: "Sequence", blurb: "An ordered stack of nodes", hue: "sequence" },
  { kind: "checkpoint", label: "Checkpoint", blurb: "An assertion on the run", hue: "checkpoint" },
];

const GRAPH_CONTROLLERS: readonly PaletteEntry[] = [
  { kind: "goto", label: "Goto", blurb: "A bounded jump to a first-level node", hue: "goto" },
];

/** Controllers, split into a Structure tab and a Graph tab. */
const CONTROLLERS: PaletteGroup = {
  title: "Controller",
  entries: [...STRUCTURE_CONTROLLERS, ...GRAPH_CONTROLLERS],
  tabs: [
    { key: "structure", label: "Structure", entries: STRUCTURE_CONTROLLERS },
    { key: "graph", label: "Graph", entries: GRAPH_CONTROLLERS },
  ],
};

export function paletteGroups(plugins: WireStepPlugin[]): readonly PaletteGroup[] {
  return [stepGroup(plugins), CONTROLLERS];
}

/** The leaf step type a block's auto-filled occupants take — the first Step entry, else `prompt`. */
export function defaultLeafKind(plugins: WireStepPlugin[]): string {
  return plugins[0]?.name ?? "prompt";
}
