import { useState } from "react";
import type { TemplateSummary, WireStepPlugin } from "@path/client-core";
import { paletteGroups, templateGroups, type PaletteEntry } from "./palette-data.js";
import type { TemplateListLoad } from "./template-list.js";

type PaletteTab = "build" | "templates";

const TABS: readonly { key: PaletteTab; label: string }[] = [
  { key: "build", label: "Build" },
  { key: "templates", label: "Templates" },
];

/**
 * The palette rail (#368, #577): a **Build** | **Templates** tab pair (#564 variant C). Build holds the
 * primitives the author places from — Step + Controller. A click **arms** an entry's kind; the canvas
 * then opens every socket the grammar admits it into (§ Adding — an illegal socket never opens, so an
 * illegal drop is unreachable). A second click on the armed card disarms it.
 *
 * The Step group is registry-driven (`paletteGroups`): one card per leaf type the received registry
 * describes, plus the `workflow` ref. Until the registry lands the Step list is just `workflow`; the
 * Controller group is fixed by the grammar and always shown.
 *
 * Templates holds the Step-Template and Workflow-Template categories from `GET /v0/templates`. Listing
 * only: selecting a template does nothing yet (insert is #578, instantiate is #579), and an invalid
 * template is shown disabled with its error.
 */
export function Palette({
  plugins,
  templateList,
  armedKind,
  onArm,
}: {
  plugins: WireStepPlugin[];
  templateList: TemplateListLoad;
  armedKind: string | null;
  onArm: (kind: string | null) => void;
}) {
  const [tab, setTab] = useState<PaletteTab>("build");
  return (
    <>
      <div className="palette-tabs" role="tablist" aria-label="Palette sections">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`palette-tab-${key}`}
            className="palette-tab"
            aria-selected={tab === key}
            aria-controls={`palette-panel-${key}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="palette" role="tabpanel" id={`palette-panel-${tab}`} aria-labelledby={`palette-tab-${tab}`}>
        {tab === "build" ? (
          <BuildTab plugins={plugins} armedKind={armedKind} onArm={onArm} />
        ) : (
          <TemplatesTab templateList={templateList} />
        )}
      </div>
    </>
  );
}

/** One titled palette section, labelled by its heading. */
function PaletteGroupSection({ title, children }: { title: string; children: React.ReactNode }) {
  const titleId = `palette-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section className="palette-group" aria-labelledby={titleId}>
      <h3 className="palette-group-title" id={titleId}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function BuildTab({
  plugins,
  armedKind,
  onArm,
}: {
  plugins: WireStepPlugin[];
  armedKind: string | null;
  onArm: (kind: string | null) => void;
}) {
  return (
    <>
      {paletteGroups(plugins).map((group) => (
        <PaletteGroupSection key={group.title} title={group.title}>
          <ul className="palette-list">
            {group.entries.map((entry) => (
              <PaletteCard key={entry.kind} entry={entry} armed={armedKind === entry.kind} onArm={onArm} />
            ))}
          </ul>
        </PaletteGroupSection>
      ))}
    </>
  );
}

function TemplatesTab({ templateList }: { templateList: TemplateListLoad }) {
  if (templateList.phase === "loading") return <p className="palette-note">Loading templates…</p>;
  if (templateList.phase === "error") {
    return (
      <p className="palette-note palette-note-error" role="alert">
        Could not list templates: {templateList.message}
      </p>
    );
  }
  return (
    <>
      {templateGroups(templateList.templates).map((group) => (
        <PaletteGroupSection key={group.title} title={group.title}>
          {group.templates.length === 0 ? (
            <p className="palette-note">{group.emptyText}</p>
          ) : (
            <ul className="palette-list">
              {group.templates.map((template) => (
                <TemplateCard key={`${template.origin}:${template.kind}:${template.name}`} template={template} />
              ))}
            </ul>
          )}
        </PaletteGroupSection>
      ))}
    </>
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

/**
 * One template card: the file-stem name, the blurb, a `shipped` tag for a read-only shipped row, and —
 * for an invalid row — the server's error, with the card disabled so it cannot be selected.
 */
function TemplateCard({ template }: { template: TemplateSummary }) {
  const style = { "--card-fg": "var(--k-template)", "--card-bg": "var(--k-template-bg)" } as React.CSSProperties;
  return (
    <li>
      <button type="button" className="palette-card" style={style} disabled={!template.valid}>
        <span className="palette-card-swatch" aria-hidden="true" />
        <span className="palette-card-text">
          <span className="palette-card-label">{template.name}</span>
          <span className="palette-card-blurb">{template.description}</span>
          {template.valid ? null : <span className="palette-card-error">{template.error?.message ?? "invalid template"}</span>}
        </span>
        {template.origin === "shipped" ? <span className="palette-card-tag">shipped</span> : null}
      </button>
    </li>
  );
}
