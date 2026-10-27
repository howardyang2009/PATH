import type { Message } from "@path/i18n";
import { useMessage } from "@path/i18n/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import type { Upload } from "./upload.js";
import type { UploadOutcome } from "./upload-file.js";

/**
 * Upload as copy: another file in the user's view holds the uploaded file's id or name, so it goes
 * in under a fresh id and a name the user picks, prefilled `<stem>-copy`. A refusal stays in the
 * dialog so the user can pick another name.
 */
export function UploadCopyDialog({
  upload,
  create,
  onDone,
  onCancel,
}: {
  upload: Upload;
  create: (name: string) => Promise<UploadOutcome>;
  onDone: (outcome: UploadOutcome) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTranslations("designer.uploadCopyDialog");
  const renderMessage = useMessage();
  const [name, setName] = useState(`${upload.stem}-copy`);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const suffix = upload.fileName.slice(upload.stem.length);
  const canSubmit = name.trim() !== "" && !submitting;

  const submit = (): void => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    void create(name.trim()).then((outcome) => {
      setSubmitting(false);
      if (outcome.status === "refused") setError(outcome.message);
      else onDone(outcome);
    });
  };

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label={t("title")}>
      <div className="dialog new-file-dialog">
        <h2 className="dialog-title">{t("title")}</h2>
        <p className="dialog-hint">{t("hint", { name: upload.fileName })}</p>
        <label className="dialog-field">
          <span className="dialog-label">{t("name")}</span>
          <span className="new-file-name">
            <input
              className="new-file-stem"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
                if (event.key === "Escape") onCancel();
              }}
              // biome-ignore lint/a11y/noAutofocus: the dialog's one field.
              autoFocus
            />
            <span className="new-file-suffix" aria-hidden="true">
              {suffix}
            </span>
          </span>
        </label>
        {error ? (
          <p className="new-file-error" role="alert">
            {renderMessage(error)}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            {t("cancel")}
          </button>
          <button type="button" className="new-file-create" onClick={submit} disabled={!canSubmit}>
            {t("upload")}
          </button>
        </div>
      </div>
    </div>
  );
}
