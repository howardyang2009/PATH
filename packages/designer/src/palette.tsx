import { useState } from "react";
import type { TemplateSummary, WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { paletteGroups, templateGroups, type PaletteEntry, type PaletteSubTab } from "./palette-data.js";
import type { TemplateListLoad } from "./template-list.js";
import type { Armed, ArmedState } from "./use-armed.js";

type PaletteTab = "build" | "templates";

const TABS: readonly { key: PaletteTab; label: string }[] = [
  { key: "build", label: "Build" },
  { key: "templates", label: "Templates" },
];

/**
 * The palette rail (#368, #577): a **Build** | **Templates** tab pair (#564 variant C). Build holds the
 * primitives the author places from — Step + Controller; Controller splits into a
 * **Structure** | **Graph** sub-tab pair, with `goto` on Graph. A click **arms** an entry's kind; the canvas
 * then opens every socket the grammar admits it into (§ Adding — an illegal socket never opens, so an
 * illegal drop is unreachable). A second click on the armed card disarms it.
 *
 * The Step group is registry-driven (`paletteGroups`): one card per leaf type the received registry
 * describes, plus the `workflow` ref. Until the registry lands the Step list is just `workflow`; the
 * Controller group is fixed by the grammar and always shown.
 *
 * Templates holds the Step-Template category from `GET /v0/templates` (the only kind, ADR 0063). A
 * Step-Template card arms like a Build card (#578): the click reads the template's body, and the canvas
 * then opens the sockets the grammar admits that body into. In template mode, a double-click on a card
 * opens the template file itself in author mode (#580); in workflow
 * mode the Templates tab only inserts, so a double-click never leaves the open workflow. A failed read says why
 * instead, and an invalid template is shown disabled with its error.
 */
export function Palette({
  plugins,
  templateList,
  arming,
  onEditTemplate,
  canEditTemplates,
}: {
  plugins: WireStepPlugin[];
  templateList: TemplateListLoad;
  arming: ArmedState;
  /** Open a template's own source file in author mode (#580). */
  onEditTemplate: (template: TemplateSummary) => void;
  /** Does a double-click on a template card open it for edit? Only in template mode. */
  canEditTemplates: boolean;
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
          <BuildTab plugins={plugins} armed={arming.armed} onArm={arming.arm} />
        ) : (
          <TemplatesTab
            templateList={templateList}
            arming={arming}
            onEditTemplate={onEditTemplate}
            canEditTemplates={canEditTemplates}
          />
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
  armed,
  onArm,
}: {
  plugins: WireStepPlugin[];
  armed: Armed | null;
  onArm: (armed: Armed | null) => void;
}) {
  return (
    <>
      {paletteGroups(plugins).map((group) => (
        <PaletteGroupSection key={group.title} title={group.title}>
          {group.tabs === undefined ? (
            <PaletteCardList entries={group.entries} armed={armed} onArm={onArm} />
          ) : (
            <PaletteSubTabs group={group.title} tabs={group.tabs} armed={armed} onArm={onArm} />
          )}
        </PaletteGroupSection>
      ))}
    </>
  );
}

function PaletteCardList({
  entries,
  armed,
  onArm,
}: {
  entries: readonly PaletteEntry[];
  armed: Armed | null;
  onArm: (armed: Armed | null) => void;
}) {
  return (
    <ul className="palette-list">
      {entries.map((entry) => (
        <PaletteCard
          key={entry.kind}
          entry={entry}
          armed={armed?.kind === "node" && armed.type === entry.kind}
          onArm={(kind) => onArm(kind === null ? null : { kind: "node", type: kind })}
        />
      ))}
    </ul>
  );
}

/** A group's sub-tabs (the Controller group: Structure | Graph). The first tab is selected by default. */
function PaletteSubTabs({
  group,
  tabs,
  armed,
  onArm,
}: {
  group: string;
  tabs: readonly PaletteSubTab[];
  armed: Armed | null;
  onArm: (armed: Armed | null) => void;
}) {
  const [selected, setSelected] = useState(tabs[0]!.key);
  const current = tabs.find((tab) => tab.key === selected) ?? tabs[0]!;
  const prefix = `palette-${group.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <>
      <div className="palette-subtabs" role="tablist" aria-label={`${group} sections`}>
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${prefix}-tab-${key}`}
            className="palette-subtab"
            aria-selected={current.key === key}
            aria-controls={`${prefix}-panel-${key}`}
            onClick={() => setSelected(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${prefix}-panel-${current.key}`} aria-labelledby={`${prefix}-tab-${current.key}`}>
        <PaletteCardList entries={current.entries} armed={armed} onArm={onArm} />
      </div>
    </>
  );
}

function TemplatesTab({
  templateList,
  arming,
  onEditTemplate,
  canEditTemplates,
}: {
  templateList: TemplateListLoad;
  arming: ArmedState;
  onEditTemplate: (template: TemplateSummary) => void;
  canEditTemplates: boolean;
}) {
  if (templateList.phase === "loading") return <p className="palette-note">Loading templates…</p>;
  if (templateList.phase === "error") {
    return (
      <p className="palette-note palette-note-error" role="alert">
        Could not list templates: {templateList.message}
      </p>
    );
  }
  const { armed } = arming;
  return (
    <>
      {arming.templateError !== null ? (
        <p className="palette-note palette-note-error" role="alert">
          {arming.templateError}
        </p>
      ) : null}
      {templateGroups(templateList.templates).map((group) => (
        <PaletteGroupSection key={group.title} title={group.title}>
          {group.templates.length === 0 ? (
            <p className="palette-note">{group.emptyText}</p>
          ) : (
            <ul className="palette-list">
              {group.templates.map((template) => (
                <TemplateCard
                  key={`${template.origin}:${template.kind}:${template.name}`}
                  template={template}
                  armed={armed?.kind === "step-template" && armed.id === template.id}
                  canEdit={canEditTemplates}
                  onSelect={() => arming.armTemplate(template)}
                  onDisarm={() => arming.arm(null)}
                  onEdit={() => onEditTemplate(template)}
                />
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
 * for an invalid row — the server's error, with the card disabled so it cannot be selected. A
 * Step-Template card is an arm toggle like a Build card (#578). In template mode (`canEdit`), a
 * double-click on a card opens its template file in author mode (#580). The card is only `aria-disabled`, so the double-click still reaches a
 * disabled card: an author can open a broken template to repair it (ADR 0050 decision 5).
 */
function TemplateCard({
  template,
  armed,
  canEdit,
  onSelect,
  onDisarm,
  onEdit,
}: {
  template: TemplateSummary;
  armed: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onDisarm: () => void;
  onEdit: () => void;
}) {
  const style = { "--card-fg": "var(--k-template)", "--card-bg": "var(--k-template-bg)" } as React.CSSProperties;
  const disabled = !template.valid;
  const editable = canEdit && template.id !== null;
  const editHint = canEdit ? "Double-click to edit the template." : "Switch to Template mode to edit this template.";
  return (
    <li>
      <button
        type="button"
        className="palette-card"
        style={style}
        aria-disabled={disabled}
        title={template.id !== null ? editHint : undefined}
        aria-pressed={armed}
        data-armed={armed ? "true" : "false"}
        onClick={disabled ? undefined : armed ? onDisarm : onSelect}
        onDoubleClick={editable ? onEdit : undefined}
      >
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
