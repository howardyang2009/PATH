/**
 * The static palette shell for the tracer bullet (#366). The palette is split into two groups the
 * spec fixes (§ The v1 authoring palette): **Steps** — one entry per leaf step type — and **Blocks** —
 * the four logicers plus `checkpoint`, fixed by the grammar.
 *
 * These entries are a **placeholder shell**, not the live palette. The Steps half is ultimately
 * *registry-driven*: a later ticket replaces this hardcoded trio with `GET /v0/step-plugins`, one
 * entry per leaf type the received registry describes (ADR 0018, spec § The palette is
 * registry-driven). The three shown here — `prompt`, `binary`, `workflow` — are the first-class trio
 * the Designer will ship hand-built editors for, kept static so the shell reads true before the wire
 * route lands. The Blocks half is grammar-fixed and stays as-is.
 *
 * `kind` names the CSS hue token (`--k-<kind>`), shared with `canvas.prototype.html` so the author
 * learns one palette. No entry is draggable yet — dragging a block into a socket is a later ticket.
 */
export interface PaletteEntry {
  /** The node `type` discriminant / block keyword, e.g. `prompt`, `parallel`. */
  readonly id: string;
  /** The palette label shown to the author. */
  readonly label: string;
  /** One-line description of what the entry authors. */
  readonly blurb: string;
  /** The hue token key: `--k-<kind>` / `--k-<kind>-bg`. */
  readonly kind: string;
}

export interface PaletteGroup {
  readonly title: string;
  readonly entries: readonly PaletteEntry[];
}

/** Steps — one entry per leaf step type. Static placeholder for the registry-driven list (above). */
const STEPS: PaletteGroup = {
  title: "Steps",
  entries: [
    { id: "prompt", label: "Prompt", blurb: "LLM prompt against a model", kind: "step" },
    { id: "binary", label: "Binary", blurb: "A command with args and cwd", kind: "step" },
    { id: "workflow", label: "Workflow", blurb: "A sub-workflow reference", kind: "workflow" },
  ],
};

/** Blocks — the four logicers plus checkpoint, fixed by the grammar (§ What is authorable). */
const BLOCKS: PaletteGroup = {
  title: "Blocks",
  entries: [
    { id: "parallel", label: "Parallel", blurb: "Branches with a join mode", kind: "parallel" },
    { id: "branch", label: "Branch", blurb: "First-match arms with an else", kind: "branch" },
    { id: "while-do", label: "While-do", blurb: "A bounded loop over one body", kind: "while" },
    { id: "sequence", label: "Sequence", blurb: "An ordered stack of nodes", kind: "sequence" },
    { id: "checkpoint", label: "Checkpoint", blurb: "An assertion on the run", kind: "checkpoint" },
  ],
};

export const PALETTE_GROUPS: readonly PaletteGroup[] = [STEPS, BLOCKS];
