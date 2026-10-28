import type { Message } from "@path/i18n";
import { useMessage } from "@path/i18n/react";
import { FOLDER_PATTERN } from "@path/schema";
import { useId, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { type DiscoveryLoad, discoveredUserFolders, discoveredUserRoot } from "./discovery.js";
import { type TemplateListLoad, templateFolders } from "./template-list.js";
import type { Upload } from "./upload.js";
import type { UploadOutcome } from "./upload-file.js";

/**
 * Upload's destination: the folder of the user root a read file goes into. The field offers every
 * folder the user root already has and takes a typed new one, which the write creates. A refusal
 * stays in the dialog so the user can pick another folder.
 */
export function UploadDialog({
  upload,
  discovery,
  templateList,
  start,
  onDone,
  onCancel,
}: {
  upload: Upload;
  discovery: DiscoveryLoad;
  templateList: TemplateListLoad;
  start: (folder: string) => Promise<UploadOutcome>;
  onDone: (outcome: UploadOutcome) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTranslations("designer.uploadDialog");
  const renderMessage = useMessage();
  const listId = useId();
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const folders = useMemo(
    () => userFolders(upload.kind, discovery, templateList),
    [upload.kind, discovery, templateList],
  );
  // A leading or trailing `/` names the same folder.
  const folder = typed.trim().replace(/^\/+|\/+$/g, "");
  const folderLegal = folder === "" || FOLDER_PATTERN.test(folder);
  const canSubmit = folderLegal && !submitting;
  const userRoot = discoveredUserRoot(discovery);
  const top = upload.kind === "workflow" ? userRoot : t("myTemplates");
  const target =
    top === undefined
      ? undefined
      : [top, folder, upload.fileName].filter((part) => part !== "").join("/");

  const submit = (): void => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    void start(folder).then((outcome) => {
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
          <span className="dialog-label">{t("folder")}</span>
          <span className="new-file-name">
            <input
              className="new-file-stem"
              list={listId}
              placeholder={t("top")}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
                if (event.key === "Escape") onCancel();
              }}
              // biome-ignore lint/a11y/noAutofocus: the dialog's one field.
              autoFocus
            />
          </span>
          <datalist id={listId}>
            {folders.map((dir) => (
              <option key={dir} value={dir} />
            ))}
          </datalist>
        </label>
        <p className="dialog-hint">
          {t.rich("folderHint", { code: (chunks) => <code>{chunks}</code> })}
        </p>
        {target !== undefined && folderLegal ? (
          <p className="new-file-target" data-testid="upload-target">
            {t.rich("uploadsTo", { path: target, code: (chunks) => <code>{chunks}</code> })}
          </p>
        ) : null}
        {!folderLegal ? <p className="new-file-error">{t("badFolder")}</p> : null}
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

/** The folders the user root of `kind` already has, relative to it. */
function userFolders(
  kind: Upload["kind"],
  discovery: DiscoveryLoad,
  templateList: TemplateListLoad,
): readonly string[] {
  return kind === "template"
    ? templateFolders(templateList, "user")
    : discoveredUserFolders(discovery);
}
