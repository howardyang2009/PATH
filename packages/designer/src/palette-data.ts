import type { WireStepPlugin } from "@path/client-core";
import { nodeKind } from "./node-kind.js";

/**
 * The palette's categories, split across the two rail tabs. The **Nodes** tab: **Step** — one
 * registry-driven entry per leaf step type (the `workflow` ref included) — and **Controller**,
 * fixed by the grammar and split into Structure | Graph. The **Templates** tab: one card per `GET
 * /v0/templates` entry, with no group heading (one kind only, ADR 0063).
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

/** A palette card for `kind`, its label, blurb and hue read from the one node-kind table. */
function entry(kind: string): PaletteEntry {
  const { label, blurb, hue } = nodeKind(kind);
  return { kind, label, blurb, hue };
}

function stepGroup(plugins: WireStepPlugin[]): PaletteGroup {
  return {
    title: "Step",
    entries: [...plugins.map((plugin) => entry(plugin.name)), entry("workflow")],
  };
}

/** The five Structure Controllers, checkpoint included, fixed by the grammar (§ What is
 * authorable). */
const STRUCTURE_CONTROLLERS: readonly PaletteEntry[] = [
  "parallel",
  "branch",
  "while-do",
  "sequence",
  "checkpoint",
].map(entry);

const GRAPH_CONTROLLERS: readonly PaletteEntry[] = ["goto"].map(entry);

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

/** The leaf step type a block's auto-filled occupants take — the first Step entry, else
 * `prompt`. */
export function defaultLeafKind(plugins: WireStepPlugin[]): string {
  return plugins[0]?.name ?? "prompt";
}
