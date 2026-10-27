import type { Message } from "@path/i18n";
import { useMessage } from "@path/i18n/react";
import { useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { TEMPLATE_SUFFIX } from "./session-reducer.js";
import type { TemplateListLoad } from "./template-list.js";
import { FOLDER_PATTERN } from "./upload.js";
import type { SaveAsResult, TemplateSource } from "./use-open-file.js";

/** A template name is its file stem, so it must match `NameSchema` (server-api-v0.md §10.3). */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** What the dialog hands back: the template's name, its optional subfolder, and description. */
export interface TemplateSaveInput {
  name: string;
  folder?: string;
  /** `"shared"` saves into the team's shared folder; absent saves into the user's own. */
  origin?: "shared";
  description: string;
}

/**
 * The save-as-template dialog: a new template lands in the user's own template folder or the
 * shared one, as the Folder picker says, and the author adds the name and description (required —
 * it is the palette blurb). Prefills
 * from an opened template's copy or a workflow's name. Create is create-only: a taken name is
 * refused, never overwritten.
 */
export function SaveTemplateAsDialog({
  source,
  workflowName,
  droppedFields = [],
  templateList,
  create,
  onCreated,
  onCancel,
}: {
  /** The opened template this saves a copy of, or `null` for a new template or a workflow's
   * save. */
  source: TemplateSource | null;
  /** The open workflow's name, when workflow mode saves it as a template (`source` is then
   * `null`). */
  workflowName?: string;
  /** The source workflow's non-empty workflow-level fields a save as template drops. */
  droppedFields?: readonly string[];
  /** The scanned templates: the user's and the shared subfolders fill the Folder picker. */
  templateList: TemplateListLoad;
  create: (input: TemplateSaveInput) => Promise<SaveAsResult>;
  onCreated: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTranslations("designer");
  const format = useFormatter();
  const renderMessage = useMessage();
  const fromWorkflow = workflowName !== undefined;
  // A template source's name is taken, so its copy is prefilled `<name>-copy`; a workflow's name is
  // not a template's.
  const [name, setName] = useState(source ? `${source.name}-copy` : (workflowName ?? ""));
  const [description, setDescription] = useState(source?.description ?? "");
  // A picker value is `<origin>:<subfolder>`, the subfolder `""` at an origin's top.
  const [picked, setPicked] = useState(`user:`);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Message | null>(null);

  const suffix = TEMPLATE_SUFFIX;
  const trimmed = name.trim();
  const path = trimmed.toLowerCase().endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
  // `folder1/name`: the last segment is the template's name, the rest its subfolder.
  const cut = path.lastIndexOf("/");
  const typedFolder = cut === -1 ? "" : path.slice(0, cut);
  const clean = path.slice(cut + 1);
  const legal = NAME_PATTERN.test(clean);
  const folderLegal = typedFolder === "" || FOLDER_PATTERN.test(typedFolder);
  const pickedOrigin = picked.startsWith("shared:") ? "shared" : "user";
  const pickedDir = picked.slice(picked.indexOf(":") + 1);
  const joined = [pickedDir, typedFolder].filter((part) => part !== "").join("/");
  const folder = joined === "" ? undefined : joined;
  const myTemplates = t("saveTemplateAsDialog.myTemplates");
  const sharedTemplates = t("saveTemplateAsDialog.sharedTemplates");
  const folders = useMemo(
    () => writableFolders(templateList, { user: myTemplates, shared: sharedTemplates }),
    [templateList, myTemplates, sharedTemplates],
  );
  const described = description.trim() !== "";
  const canSubmit = legal && folderLegal && described && !submitting;
  const title = fromWorkflow
    ? t("saveTemplateAsDialog.titleFromWorkflow")
    : source
      ? t("saveTemplateAsDialog.titleCopy")
      : t("saveTemplateAsDialog.titleNew");

  const submit = (): void => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    void create({
      name: clean,
      ...(folder === undefined ? {} : { folder }),
      ...(pickedOrigin === "shared" ? { origin: "shared" as const } : {}),
      description: description.trim(),
    }).then((result) => {
      setSubmitting(false);
      if (result.status === "created") onCreated();
      else if (result.status === "exists")
        setError({ key: "designer.saveTemplateAsDialog.exists" });
      else setError(result.message);
    });
  };

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog new-file-dialog">
        <h2 className="dialog-title">{title}</h2>
        <p className="dialog-hint">
          {fromWorkflow
            ? t("saveTemplateAsDialog.hintFromWorkflow")
            : source
              ? t("saveTemplateAsDialog.hintCopy")
              : t("saveTemplateAsDialog.hintNew")}
        </p>

        <label className="dialog-field">
          <span className="dialog-label">{t("saveTemplateAsDialog.folder")}</span>
          <select
            className="new-file-directory"
            aria-label={t("saveTemplateAsDialog.folder")}
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
          >
            {folders.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="dialog-field">
          <span className="dialog-label">{t("saveTemplateAsDialog.name")}</span>
          <span className="new-file-name">
            <input
              className="new-file-stem"
              aria-label={t("saveTemplateAsDialog.nameLabel")}
              placeholder={t("saveDialog.placeholder")}
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
          <span className="dialog-label">{t("saveTemplateAsDialog.description")}</span>
          <textarea
            className="template-description"
            aria-label={t("saveTemplateAsDialog.descriptionLabel")}
            rows={3}
            placeholder={t("saveTemplateAsDialog.descriptionPlaceholder")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        {!folderLegal ? (
          <p className="new-file-error">{t("saveTemplateAsDialog.badFolder")}</p>
        ) : null}
        {!legal && clean !== "" ? (
          <p className="new-file-error">{t("saveTemplateAsDialog.badName")}</p>
        ) : null}
        <p className="dialog-hint">
          {t.rich("saveDialog.subfolderHint", { code: (chunks) => <code>{chunks}</code> })}
        </p>
        {!described ? (
          <p className="dialog-hint">{t("saveTemplateAsDialog.needsDescription")}</p>
        ) : null}
        {fromWorkflow ? (
          <p className="dialog-hint" role="note">
            {droppedFields.length > 0
              ? t("saveTemplateAsDialog.keepsBodyDropping", {
                  droppedFields: format.list(droppedFields, { type: "conjunction" }),
                })
              : t("saveTemplateAsDialog.keepsBody")}
          </p>
        ) : null}
        {error !== null ? (
          <p className="new-file-error" role="alert">
            {renderMessage(error)}
          </p>
        ) : null}

        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            {t("saveDialog.cancel")}
          </button>
          <button type="button" className="new-file-create" onClick={submit} disabled={!canSubmit}>
            {submitting ? t("saveDialog.saving") : t("saveDialog.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The folders a template can be saved into: the user's own and the shared template folder, each
 * with every subfolder (ancestors included) found by the last scan. `tops` labels each origin's
 * top folder. */
function writableFolders(
  list: TemplateListLoad,
  tops: { user: string; shared: string },
): { value: string; label: string }[] {
  const origins = [
    { origin: "user", top: tops.user, prefix: "" },
    { origin: "shared", top: tops.shared, prefix: "shared/" },
  ] as const;
  return origins.flatMap(({ origin, top, prefix }) => {
    const dirs = new Set<string>([""]);
    if (list.phase === "ready") {
      for (const template of list.templates) {
        if (template.origin !== origin) continue;
        let dir = template.folder ?? "";
        while (dir !== "" && !dirs.has(dir)) {
          dirs.add(dir);
          dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
        }
      }
    }
    return [...dirs].sort().map((dir) => ({
      value: `${origin}:${dir}`,
      label: dir === "" ? top : `${prefix}${dir}`,
    }));
  });
}
