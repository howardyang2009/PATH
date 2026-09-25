import { useState } from "react";
import type { SaveAsTemplateResult } from "./use-open-file.js";

/** A template name is its file stem, so it must match `NameSchema` (server-api-v0.md §10.3). */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Author mode's **Save as template** dialog (#580). A new user template always lands in
 * `.path/template/<kind>-template/` (`POST /v0/templates` picks the place), so the author chooses only
 * the name. The suffix is fixed by the source template's kind. The create is create-only: a taken name is
 * refused ("choose another name"), never an overwrite, and only a `created` closes the dialog.
 */
export function SaveTemplateAsDialog({
  templateName,
  suffix,
  create,
  onCreated,
  onCancel,
}: {
  /** The source template's name; the prefilled stem is `<name>-copy`, since the source name is taken. */
  templateName: string;
  /** The fixed file suffix, `.workflow-template.json` or `.step-template.json`. */
  suffix: string;
  create: (name: string) => Promise<SaveAsTemplateResult>;
  onCreated: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState(`${templateName}-copy`);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const clean = trimmed.toLowerCase().endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
  const legal = NAME_PATTERN.test(clean);
  const canSubmit = legal && !submitting;

  const submit = (): void => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    void create(clean).then((result) => {
      setSubmitting(false);
      if (result.status === "created") onCreated();
      else if (result.status === "exists") setError("A template with that name already exists. Choose another name.");
      else setError(result.message);
    });
  };

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label="Save as new template">
      <div className="dialog new-file-dialog">
        <h2 className="dialog-title">Save as new template</h2>
        <p className="dialog-hint">The copy gets a new identity and is saved with this project's templates.</p>

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

        {!legal && clean !== "" ? (
          <p className="new-file-error">Use lowercase letters, digits, and hyphens, starting with a letter.</p>
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
