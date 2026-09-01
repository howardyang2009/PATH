import type { WireStepPlugin } from "@path/client-core";

/**
 * The palette's two groups (#368, designer-spec § The v1 authoring palette): **Steps** — one entry per
 * leaf step type — and **Blocks** — the four logicers plus `checkpoint`, fixed by the grammar.
 *
 * The Steps half is **registry-driven** (ADR 0018, § The palette is registry-driven): one card per
 * leaf type the received `GET /v0/step-plugins` snapshot describes (`prompt`, `binary`, and any plugin
 * such as `api-call`), plus `workflow` — the sub-workflow ref, core grammar rather than a plugin, but a
 * leaf-step entry in the palette all the same. The Blocks half is grammar-fixed.
 *
 * Each entry's `kind` is the node `type` a place mints and the CSS hue token (`--k-<kind>`); `hue` is
 * the hue key when it differs from `kind` (a `while-do` block paints the `while` hue; the `workflow`
 * ref keeps its own). No entry is a closed constant any more — the Steps list is a function of the
 * registry the session received.
 */
export interface PaletteEntry {
  /** The node `type` discriminant a place mints, e.g. `prompt`, `parallel`, `while-do`. */
  readonly kind: string;
  /** The palette label shown to the author. */
  readonly label: string;
  /** One-line description of what the entry authors. */
  readonly blurb: string;
  /** The hue token key `--k-<hue>` / `--k-<hue>-bg`; defaults to `kind` when omitted. */
  readonly hue: string;
}

export interface PaletteGroup {
  readonly title: string;
  readonly entries: readonly PaletteEntry[];
}

/** Title-case a leaf type name for its palette label: `api-call` → `Api-call`, `prompt` → `Prompt`. */
function titleCase(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

/** The blurb for a first-class leaf type; a plugin type gets a generic one. */
function leafBlurb(name: string): string {
  if (name === "prompt") return "LLM prompt against a model";
  if (name === "binary") return "A command with args and cwd";
  return `A ${name} step`;
}

/** The Steps group for a received registry: one card per plugin leaf type, plus the `workflow` ref. */
function stepsGroup(plugins: WireStepPlugin[]): PaletteGroup {
  const fromRegistry: PaletteEntry[] = plugins.map((plugin) => ({
    kind: plugin.name,
    label: titleCase(plugin.name),
    blurb: leafBlurb(plugin.name),
    hue: "step",
  }));
  const workflowRef: PaletteEntry = { kind: "workflow", label: "Workflow", blurb: "A sub-workflow reference", hue: "workflow" };
  return { title: "Steps", entries: [...fromRegistry, workflowRef] };
}

/** Blocks — the four logicers plus checkpoint, fixed by the grammar (§ What is authorable). */
const BLOCKS: PaletteGroup = {
  title: "Blocks",
  entries: [
    { kind: "parallel", label: "Parallel", blurb: "Branches with a join mode", hue: "parallel" },
    { kind: "branch", label: "Branch", blurb: "First-match arms with an else", hue: "branch" },
    { kind: "while-do", label: "While-do", blurb: "A bounded loop over one body", hue: "while" },
    { kind: "sequence", label: "Sequence", blurb: "An ordered stack of nodes", hue: "sequence" },
    { kind: "checkpoint", label: "Checkpoint", blurb: "An assertion on the run", hue: "checkpoint" },
  ],
};

/** The palette's groups for a received registry snapshot: registry-driven Steps, then grammar-fixed Blocks. */
export function paletteGroups(plugins: WireStepPlugin[]): readonly PaletteGroup[] {
  return [stepsGroup(plugins), BLOCKS];
}

/** The leaf step type a block's auto-filled occupants take — the first Steps entry, else `prompt`. */
export function defaultLeafKind(plugins: WireStepPlugin[]): string {
  return plugins[0]?.name ?? "prompt";
}
