import { useMemo, useState } from "react";
import { TEMPLATE_SUFFIX } from "./session-reducer.js";
import type { TemplateListLoad } from "./template-list.js";
import type { SaveAsResult, TemplateSource } from "./use-open-file.js";

/** A template name is its file stem, so it must match `NameSchema` (server-api-v0.md §10.3). */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** A subfolder path of plain names, as the Server accepts it: no empty, dot-leading, or backslash
 * segments. */
const FOLDER_PATTERN = /^[^\\./\0][^\\/\0]*(\/[^\\./\0][^\\/\0]*)*$/;

/** What the dialog hands back: the template's name, its optional subfolder, and description. */
export interface TemplateSaveInput {
  name: string;
  folder?: string;
  description: string;
}

/**
 * The save-as-template dialog: a new user template always lands in `users/<user-id>/template/`,
 * so the author picks only the name and description (required — it is the palette blurb). Prefills
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
  /** The scanned templates: the user's own subfolders fill the Folder picker. */
  templateList: TemplateListLoad;
  create: (input: TemplateSaveInput) => Promise<SaveAsResult>;
  onCreated: () => void;
  onCancel: () => void;
}): JSX.Element {
  const fromWorkflow = workflowName !== undefined;
  // A template source's name is taken, so its copy is prefilled `<name>-copy`; a workflow's name is
  // not a template's.
  const [name, setName] = useState(source ? `${source.name}-copy` : (workflowName ?? ""));
  const [description, setDescription] = useState(source?.description ?? "");
  const [picked, setPicked] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suffix = TEMPLATE_SUFFIX;
  const trimmed = name.trim();
  const path = trimmed.toLowerCase().endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
  // `folder1/name`: the last segment is the template's name, the rest its subfolder.
  const cut = path.lastIndexOf("/");
  const typedFolder = cut === -1 ? "" : path.slice(0, cut);
  const clean = path.slice(cut + 1);
  const legal = NAME_PATTERN.test(clean);
  const folderLegal = typedFolder === "" || FOLDER_PATTERN.test(typedFolder);
  const joined = [picked, typedFolder].filter((part) => part !== "").join("/");
  const folder = joined === "" ? undefined : joined;
  const folders = useMemo(() => userFolders(templateList), [templateList]);
  const described = description.trim() !== "";
  const canSubmit = legal && folderLegal && described && !submitting;
  const title = fromWorkflow
    ? "Save workflow as template"
    : source
      ? "Save as new template"
      : "Save new template";

  const submit = (): void => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    void create({
      name: clean,
      ...(folder === undefined ? {} : { folder }),
      description: description.trim(),
    }).then((result) => {
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
          <span className="dialog-label">Folder</span>
          <select
            className="new-file-directory"
            aria-label="Folder"
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
          >
            {folders.map((dir) => (
              <option key={dir} value={dir}>
                {dir === "" ? "(my templates)" : dir}
              </option>
            ))}
          </select>
        </label>

        <label className="dialog-field">
          <span className="dialog-label">Name</span>
          <span className="new-file-name">
            <input
              className="new-file-stem"
              aria-label="Template name"
              placeholder="name or folder/name"
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

        {!folderLegal ? (
          <p className="new-file-error">
            Folder names cannot be empty or start with a dot, and cannot contain a backslash.
          </p>
        ) : null}
        {!legal && clean !== "" ? (
          <p className="new-file-error">
            Use lowercase letters, digits, and hyphens, starting with a letter.
          </p>
        ) : null}
        <p className="dialog-hint">
          Use <code>/</code> to save in a subfolder. Missing folders are created.
        </p>
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

/** The folders a template can be saved into: the user's own template folder (`""`) and every
 * subfolder, with ancestors, found by the last scan. */
function userFolders(list: TemplateListLoad): string[] {
  const all = new Set<string>([""]);
  if (list.phase === "ready") {
    for (const template of list.templates) {
      if (template.origin !== "user") continue;
      let dir = template.folder ?? "";
      while (dir !== "" && !all.has(dir)) {
        all.add(dir);
        dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      }
    }
  }
  return [...all].sort();
}

/** `a`, `a and b`, `a, b and c`. */
function formatList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
