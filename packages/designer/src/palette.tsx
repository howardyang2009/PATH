import type { WireStepPlugin } from "@path/client-core";
import { paletteGroups, type PaletteEntry } from "./palette-data.js";

/**
 * The palette rail (#368): the Steps + Blocks list the author places from. A click **arms** an entry's
 * kind; the canvas then opens every socket the grammar admits it into (§ Adding — an illegal socket
 * never opens, so an illegal drop is unreachable). A second click on the armed card disarms it.
 *
 * The Steps half is registry-driven (`paletteGroups`): one card per leaf type the received registry
 * describes, plus the `workflow` ref. Until the registry lands the Steps list is just `workflow`; the
 * Blocks half is fixed by the grammar and always shown.
 */
export function Palette({
  plugins,
  armedKind,
  onArm,
}: {
  plugins: WireStepPlugin[];
  armedKind: string | null;
  onArm: (kind: string | null) => void;
}) {
  return (
    <div className="palette">
      {paletteGroups(plugins).map((group) => {
        const titleId = `palette-${group.title.toLowerCase().replace(/\s+/g, "-")}`;
        return (
          <section key={group.title} className="palette-group" aria-labelledby={titleId}>
            <h3 className="palette-group-title" id={titleId}>
              {group.title}
            </h3>
            <ul className="palette-list">
              {group.entries.map((entry) => (
                <PaletteCard key={entry.kind} entry={entry} armed={armedKind === entry.kind} onArm={onArm} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** One palette card — a toggle button that arms its kind. The hue swatch names the kind by colour. */
function PaletteCard({ entry, armed, onArm }: { entry: PaletteEntry; armed: boolean; onArm: (kind: string | null) => void }) {
  const style = {
    "--card-fg": `var(--k-${entry.hue})`,
    "--card-bg": `var(--k-${entry.hue}-bg)`,
  } as React.CSSProperties;
  return (
    <li>
      <button
        type="button"
        className="palette-card"
        style={style}
        aria-pressed={armed}
        data-armed={armed ? "true" : "false"}
        onClick={() => onArm(armed ? null : entry.kind)}
      >
        <span className="palette-card-swatch" aria-hidden="true" />
        <span className="palette-card-text">
          <span className="palette-card-label">{entry.label}</span>
          <span className="palette-card-blurb">{entry.blurb}</span>
        </span>
      </button>
    </li>
  );
}
