import { useState } from "react";
import { TEMPLATE_SUFFIX } from "./session-reducer.js";
import type { SaveAsResult, TemplateSource } from "./use-open-file.js";

/** A template name is its file stem, so it must match `NameSchema` (server-api-v0.md §10.3). */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** What the dialog hands back: the template's name and description. */
export interface TemplateSaveInput {
  name: string;
  description: string;
}

/**
 * The save-as-template dialog: a new user template always lands in `.path/template/step-template/`, so the
 * author picks only the name and description (required — it is the palette blurb). Prefills from an opened
 * template's copy or a workflow's name. Create is create-only: a taken name is refused, never overwritten.
 */
export function SaveTemplateAsDialog({
  source,
  workflowName,
  droppedFields = [],
  create,
  onCreated,
  onCancel,
}: {
  /** The opened template this saves a copy of, or `null` for a new template or a workflow's save. */
  source: TemplateSource | null;
  /** The open workflow's name, when workflow mode saves it as a template (`source` is then `null`). */
  workflowName?: string;
  /** The source workflow's non-empty workflow-level fields a save as template drops. */
  droppedFields?: readonly string[];
  create: (input: TemplateSaveInput) => Promise<SaveAsResult>;
  onCreated: () => void;
  onCancel: () => void;
}): JSX.Element {
  const fromWorkflow = workflowName !== undefined;
  // A template source's name is taken, so its copy is prefilled `<name>-copy`; a workflow's name is not a template's.
  const [name, setName] = useState(source ? `${source.name}-copy` : (workflowName ?? ""));
  const [description, setDescription] = useState(source?.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suffix = TEMPLATE_SUFFIX;
  const trimmed = name.trim();
  const clean = trimmed.toLowerCase().endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
  const legal = NAME_PATTERN.test(clean);
  const described = description.trim() !== "";
  const canSubmit = legal && described && !submitting;
  const title = fromWorkflow
    ? "Save workflow as template"
    : source
      ? "Save as new template"
      : "Save new template";

  const submit = (): void => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    void create({ name: clean, description: description.trim() }).then((result) => {
      setSubmitting(false);
      if (result.status === "created") onCreated();
      else if (result.status === "exists")
        setError("A template with that name already exists. Choose another name.");
      else setError(result.message);
    });
  };

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog new-file-dialog">
        <h2 className="dialog-title">{title}</h2>
        <p className="dialog-hint">
          {fromWorkflow
            ? "The template is a copy of the workflow's body with a new identity, saved with this project's templates. The workflow stays open."
            : source
              ? "The copy gets a new identity and is saved with this project's templates."
              : "The template is saved with this project's templates."}
        </p>

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
          <p className="new-file-error">
            Use lowercase letters, digits, and hyphens, starting with a letter.
          </p>
        ) : null}
        {!described ? <p className="dialog-hint">A template needs a description.</p> : null}
        {fromWorkflow ? (
          <p className="dialog-hint" role="note">
            A template keeps only the body.
            {droppedFields.length > 0 ? ` ${formatList(droppedFields)} will be dropped.` : null}
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
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
