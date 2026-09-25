import { useState } from "react";
import { templateSuffix } from "./session-reducer.js";
import type { SaveAsTemplateResult, TemplateSource } from "./use-open-file.js";

/** A template name is its file stem, so it must match `NameSchema` (server-api-v0.md §10.3). */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

type TemplateKind = TemplateSource["kind"];

/** What the dialog hands back: the name, and for a new template also its kind and description. */
export interface TemplateSaveInput {
  name: string;
  kind: TemplateKind;
  description: string;
}

/**
 * Template mode's save dialog. A new user template always lands in `.path/template/<kind>-template/`
 * (`POST /v0/templates` picks the place), so the author chooses only what the file needs:
 *
 * - **Save as…** of an opened template (`source` set, #580): the kind (preselected to the source's), the
 *   name, and the description (prefilled from the source's). Saving a workflow-template as a
 *   step-template keeps only its body, so the dialog lists the workflow-level fields it drops.
 * - First **Save** of a new template (`source` `null`): the kind (Step-template or Workflow-template),
 *   the name, and a description.
 *
 * A step-template requires a description: it is the palette blurb.
 *
 * The create is create-only: a taken name is refused ("choose another name"), never an overwrite, and
 * only a `created` closes the dialog.
 */
export function SaveTemplateAsDialog({
  source,
  droppedFields = [],
  create,
  onCreated,
  onCancel,
}: {
  /** The opened template this saves a copy of, or `null` for a new template's first save. */
  source: TemplateSource | null;
  /** The source workflow's non-empty workflow-level fields a save as step-template would drop. */
  droppedFields?: readonly string[];
  create: (input: TemplateSaveInput) => Promise<SaveAsTemplateResult>;
  onCreated: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<TemplateKind>(source?.kind ?? "step");
  // The source name is taken, so a copy is prefilled `<name>-copy`.
  const [name, setName] = useState(source ? `${source.name}-copy` : "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suffix = templateSuffix(kind);
  const trimmed = name.trim();
  const clean = trimmed.toLowerCase().endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
  const legal = NAME_PATTERN.test(clean);
  const described = kind === "workflow" || description.trim() !== "";
  const dropping = source?.kind === "workflow" && kind === "step" ? droppedFields : [];
  const canSubmit = legal && described && !submitting;
  const title = source ? "Save as new template" : "Save new template";

  const submit = (): void => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    void create({ name: clean, kind, description: description.trim() }).then((result) => {
      setSubmitting(false);
      if (result.status === "created") onCreated();
      else if (result.status === "exists") setError("A template with that name already exists. Choose another name.");
      else setError(result.message);
    });
  };

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog new-file-dialog">
        <h2 className="dialog-title">{title}</h2>
        <p className="dialog-hint">
          {source
            ? "The copy gets a new identity and is saved with this project's templates."
            : "The template is saved with this project's templates."}
        </p>

        <fieldset className="dialog-field template-kind">
          <legend className="dialog-label">Kind</legend>
          <label>
            <input type="radio" name="template-kind" checked={kind === "step"} onChange={() => setKind("step")} />
            Step-template
          </label>
          <label>
            <input type="radio" name="template-kind" checked={kind === "workflow"} onChange={() => setKind("workflow")} />
            Workflow-template
          </label>
        </fieldset>

        <label className="dialog-field">
          <span className="dialog-label">Name</span>
          <span className="new-file-name">
            <input
              className="new-file-stem"
              aria-label="Template name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
            <span className="new-file-suffix" aria-hidden="true">
              {suffix}
            </span>
          </span>
        </label>

        <label className="dialog-field">
          <span className="dialog-label">Description</span>
          <textarea
            className="template-description"
            aria-label="Template description"
            rows={3}
            placeholder="What this template does. It is shown on the palette card."
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        {!legal && clean !== "" ? (
          <p className="new-file-error">Use lowercase letters, digits, and hyphens, starting with a letter.</p>
        ) : null}
        {!described ? <p className="dialog-hint">A step-template needs a description.</p> : null}
        {source?.kind === "workflow" && kind === "step" ? (
          <p className="dialog-hint" role="note">
            A step-template keeps only the body.
            {dropping.length > 0 ? ` ${formatList(dropping)} will be dropped.` : null}
          </p>
        ) : null}
        {error !== null ? (
          <p className="new-file-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="new-file-create" onClick={submit} disabled={!canSubmit}>
            {submitting ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** `a`, `a and b`, `a, b and c`. */
function formatList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
