import { useEffect, useMemo, useState } from "react";
import type { PathApiClient } from "@path/client-core";
import type { SaveNewFileResult } from "./use-open-file.js";

/**
 * The first-save dialog for a from-scratch buffer (#390, designer-spec § New-file placement and naming).
 * Placement is decided **here**, at the first save, never at create: the author picks a directory
 * confined to the project root and a filename, and the save is an **exclusive create** — an existing path
 * is refused ("choose another name"), never a silent overwrite (ADR 0016).
 *
 * - **Where.** A directory picker over the project's discovered directories (`GET /v0/workflows`), the
 *   **project root** always offered and the default. The server confines the resolved path to the root
 *   (a path that escapes it is a `404`), so every offered choice is in-root by construction.
 * - **Name.** The filename stem is prefilled from the workflow's `name` and is author-editable, but the
 *   **`.workflow.json` suffix is enforced** — it is a fixed adornment the author cannot edit away, because
 *   discovery lists only that suffix.
 * - **Collision.** `create` runs the exclusive create; its `exists` result surfaces here as the refusal,
 *   and only a `created` closes the dialog (the App then adopts the path, acquires the lease, and enables
 *   launch).
 */
export function NewFileDialog({
  client,
  workflowName,
  create,
  onCreated,
  onCancel,
}: {
  client: PathApiClient;
  /** The buffer's own `name` — the prefilled filename stem (it slugs cleanly, `^[a-z][a-z0-9-]*$`). */
  workflowName: string;
  /** Run the exclusive create against the composed path; the dialog reads its outcome. */
  create: (targetPath: string) => Promise<SaveNewFileResult>;
  /** Called once the file is created — the App drops the dialog and the frame is now saved. */
  onCreated: (path: string) => void;
  /** Dismiss without saving; the from-scratch buffer stays on the canvas untouched. */
  onCancel: () => void;
}): JSX.Element {
  const [directories, setDirectories] = useState<string[]>([""]);
  const [directory, setDirectory] = useState("");
  const [stem, setStem] = useState(workflowName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Discover the project's directories for the picker — the parent of every known workflow, plus the
  // root. A discovery failure is not fatal: the root is always offered, so a save can still proceed.
  useEffect(() => {
    let alive = true;
    client
      .listWorkflows()
      .then((response) => {
        if (!alive) return;
        const dirs = new Set<string>([""]);
        for (const wf of response.workflows) dirs.add(dirnameOf(wf.relative_path));
        setDirectories([...dirs].sort());
      })
      .catch(() => {
        // Keep the root-only default; the picker still works, just without discovered subdirectories.
      });
    return () => {
      alive = false;
    };
  }, [client]);

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
        onCreated(result.path);
      } else if (result.status === "exists") {
        setError("A workflow already exists at that path. Choose another name.");
      } else {
        setError(result.message);
      }
    });
  };

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label="Save new workflow">
      <div className="dialog new-file-dialog">
        <h2 className="dialog-title">Save new workflow</h2>
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
 * The filename **stem**, cleaned so the dialog's own controls are the sole placement control: a trailing
 * `.workflow.json` the author typed is stripped (the suffix is appended once, never doubled), and path
 * separators are dropped so a `/`- or `..`-bearing stem cannot escape the picked directory. Confinement
 * still holds server-side (a path escaping the root is a `404`, ADR 0016); this keeps the picker honest.
 */
function normalizeStem(stem: string): string {
  return stem
    .trim()
    .replace(/\.workflow\.json$/i, "")
    .replace(/[\\/]/g, "")
    .replace(/^\.+/, "");
}

/** The `.workflow.json` filename for `stem`, appended to `directory` (root when empty) — the save target. */
function composePath(directory: string, stem: string): string {
  const filename = `${stem}.workflow.json`;
  return directory === "" ? filename : `${directory}/${filename}`;
}

/** The parent directory of a project-relative path, or `""` (the project root) for a top-level file. */
function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}
