import type { TemplateSummary } from "@path/client-core";
import { templateGroups } from "./palette-data.js";
import { templateSuffix } from "./session-reducer.js";
import type { TemplateListLoad } from "./template-list.js";

/**
 * Template mode's **Open…** picker: the project's templates (`GET /v0/templates`), grouped into
 * Step-Template and Workflow-Template like the palette's Templates tab. A choice opens that template's
 * source in template mode, the same as a double-click on its palette card. An invalid template is listed
 * too, so an author can open it and repair it.
 */
export function OpenTemplateDialog({
  templateList,
  onOpen,
  onCancel,
}: {
  templateList: TemplateListLoad;
  onOpen: (template: TemplateSummary) => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label="Open a template">
      <div className="dialog open-workflow-dialog">
        <h2 className="dialog-title">Open a template</h2>
        <p className="dialog-hint">Choose a template from this project to open and edit.</p>
        {templateList.phase === "loading" ? (
          <p className="pane-note">Loading templates…</p>
        ) : templateList.phase === "error" ? (
          <p className="new-file-error" role="alert">
            Could not list templates: {templateList.message}
          </p>
        ) : (
          templateGroups(templateList.templates).map((group) => (
            <section key={group.title} className="template-picker-group" aria-label={group.title}>
              <h3 className="dialog-label">{group.title}</h3>
              {group.templates.length === 0 ? (
                <p className="ref-existing-empty">{group.emptyText}</p>
              ) : (
                <ul className="template-picker-list">
                  {group.templates
                    .filter((template) => template.id !== null)
                    .map((template) => (
                      <li key={`${template.origin}:${template.kind}:${template.name}`}>
                        <button type="button" className="workflow-row" onClick={() => onOpen(template)}>
                          <span className="workflow-file-name">
                            {template.name}
                            {templateSuffix(template.kind)}
                          </span>
                          {template.origin === "shipped" ? <span className="palette-card-tag">shipped</span> : null}
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </section>
          ))
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
