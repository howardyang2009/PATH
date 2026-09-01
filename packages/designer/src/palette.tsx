import { PALETTE_GROUPS, type PaletteEntry } from "./palette-data.js";

/**
 * The palette shell: the left rail of the Designer, listing what the author can place. Two groups —
 * **Steps** and **Blocks** (§ The v1 authoring palette) — each a named region with one card per entry.
 *
 * Static for the tracer bullet (#366): the cards are inert (no drag, no click-to-add) and the Steps
 * list is a hardcoded placeholder for the registry-driven list a later ticket wires from
 * `GET /v0/step-plugins`. It exists so the shell reads true — the author sees the two halves and the
 * kinds each holds — before any authoring affordance lands.
 */
export function Palette() {
  return (
    <div className="palette">
      {PALETTE_GROUPS.map((group) => {
        // Slugify the title into the label id so a future multi-word group ("Control blocks") keeps a
        // valid, space-free id for the `aria-labelledby` association.
        const titleId = `palette-${group.title.toLowerCase().replace(/\s+/g, "-")}`;
        return (
          <section key={group.title} className="palette-group" aria-labelledby={titleId}>
            <h3 className="palette-group-title" id={titleId}>
              {group.title}
            </h3>
            <ul className="palette-list">
              {group.entries.map((entry) => (
                <PaletteCard key={entry.id} entry={entry} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** One inert palette card. The hue swatch names the kind by color; the label names it in words. */
function PaletteCard({ entry }: { entry: PaletteEntry }) {
  const style = {
    "--card-fg": `var(--k-${entry.kind})`,
    "--card-bg": `var(--k-${entry.kind}-bg)`,
  } as React.CSSProperties;
  return (
    <li className="palette-card" style={style}>
      <span className="palette-card-swatch" aria-hidden="true" />
      <span className="palette-card-text">
        <span className="palette-card-label">{entry.label}</span>
        <span className="palette-card-blurb">{entry.blurb}</span>
      </span>
    </li>
  );
}
