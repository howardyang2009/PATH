import { useMemo, useState } from "react";
import { type DiscoveryLoad, discoveredWorkflows } from "./discovery.js";
import type { SaveAsResult } from "./use-open-file.js";

/** Where a new workflow lands by default: the one user's own folder, until the Server knows who is
 * asking (ADR 0084). */
export const DEFAULT_WORKFLOW_DIRECTORY = "users/local/workflow";

/** The team's own workflow folder (ADR 0084). */
const SHARED_WORKFLOW_DIRECTORY = "shared/workflow";

/**
 * The first-save dialog for a from-scratch buffer (designer-spec § New-file placement and naming):
 * placement is decided here, at the first save, as an exclusive create — an existing path is
 * refused, never overwritten (ADR 0016). The author picks an in-root directory and a stem; the
 * `.workflow.json` suffix is enforced because discovery lists only that suffix, and only a
 * `created` closes the dialog.
 */
export function NewFileDialog({
  discovery,
  workflowName,
  title = "Save new workflow",
  initialDirectory = DEFAULT_WORKFLOW_DIRECTORY,
  create,
  onCreated,
  onCancel,
}: {
  discovery: DiscoveryLoad;
  /** The buffer's own `name` — the prefilled filename stem (it slugs cleanly,
   * `^[a-z][a-z0-9-]*$`). */
  workflowName: string;
  /** The dialog title; workflow-mode Save as… passes "Save workflow as". */
  title?: string;
  /** The preselected directory; a new file starts in the user folder, Save as… in the source
   * file's directory. */
  initialDirectory?: string;
  /** Run the exclusive create against the composed path; the dialog reads its outcome. */
  create: (targetPath: string) => Promise<SaveAsResult>;
  /** Called once the file is created — the App drops the dialog and the frame is now saved. */
  onCreated: (path: string) => void;
  /** Dismiss without saving; the from-scratch buffer stays on the canvas untouched. */
  onCancel: () => void;
}): JSX.Element {
  const [directory, setDirectory] = useState(initialDirectory);
  const [stem, setStem] = useState(workflowName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picker's directories: the two authored roots plus the parent of every discovered workflow
  // (ADR 0085). A failed scan is not fatal: the roots are always offered, so a save can proceed.
  const directories = useMemo(() => {
    const dirs = new Set<string>([
      DEFAULT_WORKFLOW_DIRECTORY,
      SHARED_WORKFLOW_DIRECTORY,
      initialDirectory,
    ]);
    for (const wf of discoveredWorkflows(discovery) ?? []) dirs.add(dirnameOf(wf.relative_path));
    return [...dirs].sort();
  }, [discovery, initialDirectory]);

  const cleanStem = normalizeStem(stem);
  const targetPath = useMemo(() => composePath(directory, cleanStem), [directory, cleanStem]);
  const canSubmit = cleanStem !== "" && !submitting;

  const submit = (): void => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    void create(targetPath).then((result) => {
      setSubmitting(false);
      if (result.status === "created") {
        onCreated(result.path ?? targetPath);
      } else if (result.status === "exists") {
        setError("A workflow already exists at that path. Choose another name.");
      } else {
        setError(result.message);
      }
    });
  };

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog new-file-dialog">
        <h2 className="dialog-title">{title}</h2>
        <p className="dialog-hint">Choose where in the project this workflow is saved.</p>

        <label className="dialog-field">
          <span className="dialog-label">Directory</span>
          <select
            className="new-file-directory"
            aria-label="Directory"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          >
            {directories.map((dir) => (
              <option key={dir} value={dir}>
                {dir === "" ? "(project root)" : dir}
              </option>
            ))}
          </select>
        </label>

        <label className="dialog-field">
          <span className="dialog-label">Filename</span>
          <span className="new-file-name">
            <input
              className="new-file-stem"
              aria-label="Filename"
              value={stem}
              onChange={(event) => setStem(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
            {/* The suffix is enforced, not editable: discovery lists only `*.workflow.json`. */}
            <span className="new-file-suffix" aria-hidden="true">
              .workflow.json
            </span>
          </span>
        </label>

        <p className="new-file-target" data-testid="new-file-target">
          Saves to <code>{targetPath}</code>
        </p>

        {error !== null && (
          <p className="new-file-error" role="alert">
            {error}
          </p>
        )}

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

/**
 * The filename **stem**, cleaned so the dialog's controls are the sole placement: a trailing
 * `.workflow.json` is stripped and path separators dropped, so a stem cannot escape the picked
 * directory.
 */
function normalizeStem(stem: string): string {
  return stem
    .trim()
    .replace(/\.workflow\.json$/i, "")
    .replace(/[\\/]/g, "")
    .replace(/^\.+/, "");
}

/** The `.workflow.json` filename for `stem`, appended to `directory` (root when empty) — the save
 * target. */
function composePath(directory: string, stem: string): string {
  const filename = `${stem}.workflow.json`;
  return directory === "" ? filename : `${directory}/${filename}`;
}

/** The parent directory of a project-relative path, or `""` (the project root) for a top-level
 * file. */
export function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}
