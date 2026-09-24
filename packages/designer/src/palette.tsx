import { useState } from "react";
import type { TemplateSummary, WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { paletteGroups, templateGroups, type PaletteEntry } from "./palette-data.js";
import type { TemplateListLoad } from "./template-list.js";
import type { Armed, ArmedState } from "./use-armed.js";

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
 * Templates holds the Step-Template and Workflow-Template categories from `GET /v0/templates`. A
 * Step-Template card arms like a Build card (#578): the click reads the template's body, and the canvas
 * then opens the sockets the grammar admits that body into. A Workflow-Template card is selectable only
 * into an empty canvas and fills it with an instance of the whole workflow (#579); its Edit button opens
 * the `*.workflow-template.json` itself in author mode (#580). A failed read says why instead, and an
 * invalid template is shown disabled with its error.
 */
export function Palette({
  plugins,
  templateList,
  arming,
  canvasEmpty,
  placeWorkflowInstance,
  onEditTemplate,
}: {
  plugins: WireStepPlugin[];
  templateList: TemplateListLoad;
  arming: ArmedState;
  /** Is the canvas empty? A Workflow-Template card is selectable only then (#579). */
  canvasEmpty: boolean;
  /** Put a Workflow-Template instance on the empty canvas; `false` when it is no longer empty. */
  placeWorkflowInstance: (file: WorkflowFile) => boolean;
  /** Open a Workflow-Template's own source file in author mode (#580). */
  onEditTemplate: (template: TemplateSummary) => void;
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
            canvasEmpty={canvasEmpty}
            placeWorkflowInstance={placeWorkflowInstance}
            onEditTemplate={onEditTemplate}
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
          <ul className="palette-list">
            {group.entries.map((entry) => (
              <PaletteCard
                key={entry.kind}
                entry={entry}
                armed={armed?.kind === "node" && armed.type === entry.kind}
                onArm={(kind) => onArm(kind === null ? null : { kind: "node", type: kind })}
              />
            ))}
          </ul>
        </PaletteGroupSection>
      ))}
    </>
  );
}

function TemplatesTab({
  templateList,
  arming,
  canvasEmpty,
  placeWorkflowInstance,
  onEditTemplate,
}: {
  templateList: TemplateListLoad;
  arming: ArmedState;
  canvasEmpty: boolean;
  placeWorkflowInstance: (file: WorkflowFile) => boolean;
  onEditTemplate: (template: TemplateSummary) => void;
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
                  canvasEmpty={canvasEmpty}
                  onSelect={() =>
                    template.kind === "step" ? arming.armTemplate(template) : arming.selectWorkflowTemplate(template, placeWorkflowInstance)
                  }
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
 * Step-Template card is an arm toggle like a Build card (#578). A Workflow-Template card is a one-shot
 * select, enabled only while the canvas is empty (#579). A Workflow-Template also carries an Edit button
 * that opens its `*.workflow-template.json` in author mode (#580). Edit stays enabled for an invalid row,
 * so an author can open a broken template to repair it (ADR 0050 decision 5).
 */
function TemplateCard({
  template,
  armed,
  canvasEmpty,
  onSelect,
  onDisarm,
  onEdit,
}: {
  template: TemplateSummary;
  armed: boolean;
  canvasEmpty: boolean;
  onSelect: () => void;
  onDisarm: () => void;
  onEdit: () => void;
}) {
  const style = { "--card-fg": "var(--k-template)", "--card-bg": "var(--k-template-bg)" } as React.CSSProperties;
  const armable = template.kind === "step";
  const blocked = !armable && !canvasEmpty;
  return (
    <li>
      <button
        type="button"
        className="palette-card"
        style={style}
        disabled={!template.valid || blocked}
        title={blocked ? "A Workflow-Template goes only into an empty canvas." : undefined}
        aria-pressed={armable ? armed : undefined}
        data-armed={armed ? "true" : "false"}
        onClick={armed ? onDisarm : onSelect}
      >
        <span className="palette-card-swatch" aria-hidden="true" />
        <span className="palette-card-text">
          <span className="palette-card-label">{template.name}</span>
          <span className="palette-card-blurb">{template.description}</span>
          {template.valid ? null : <span className="palette-card-error">{template.error?.message ?? "invalid template"}</span>}
        </span>
        {template.origin === "shipped" ? <span className="palette-card-tag">shipped</span> : null}
      </button>
      {template.kind === "workflow" && template.id !== null ? (
        <button
          type="button"
          className="palette-card-edit"
          aria-label={`Edit ${template.name}.workflow-template.json`}
          title="Open the template source to edit it"
          onClick={onEdit}
        >
          Edit
        </button>
      ) : null}
    </li>
  );
}
