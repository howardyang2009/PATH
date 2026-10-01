import { useMemo, useState } from "react";
import { type DiscoveryLoad, discoveredRoots, discoveredWorkflows } from "./discovery.js";
import type { SaveAsResult } from "./use-open-file.js";

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
  initialDirectory,
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
  /** The preselected directory: Save as… passes the source file's directory. Without one, a new
   * file starts in the first writable root the Server lists, the user's own (ADR 0084). */
  initialDirectory?: string;
  /** Run the exclusive create against the composed path; the dialog reads its outcome. */
  create: (targetPath: string) => Promise<SaveAsResult>;
  /** Called once the file is created — the App drops the dialog and the frame is now saved. */
  onCreated: (path: string) => void;
  /** Dismiss without saving; the from-scratch buffer stays on the canvas untouched. */
  onCancel: () => void;
}): JSX.Element {
  const roots = discoveredRoots(discovery);
  const [picked, setDirectory] = useState<string | undefined>(initialDirectory);
  // `null` until a directory is picked or discovery lands a root to default to.
  const directory = picked ?? roots[0] ?? null;
  const [stem, setStem] = useState(workflowName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picker's directories: the Server's writable roots plus the parent of every discovered
  // workflow (ADR 0085), and the preselected one.
  const directories = useMemo(() => {
    const dirs = new Set<string>(discoveredRoots(discovery));
    if (initialDirectory !== undefined) dirs.add(initialDirectory);
    for (const wf of discoveredWorkflows(discovery) ?? []) dirs.add(dirnameOf(wf.relative_path));
    return [...dirs].sort();
  }, [discovery, initialDirectory]);

  const parsed = parseStem(stem);
  const cleanStem = parsed.relative;
  const targetPath = useMemo(
    () => (directory === null || parsed.error !== null ? null : composePath(directory, cleanStem)),
    [directory, cleanStem, parsed.error],
  );
  const canSubmit = cleanStem !== "" && !submitting && targetPath !== null;
  const knownDirectories = useMemo(() => withAncestors(directories), [directories]);
  const isNewFolder = targetPath !== null && !knownDirectories.has(dirnameOf(targetPath));

  const submit = (): void => {
    if (!canSubmit || targetPath === null) return;
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
            value={directory ?? ""}
            disabled={directory === null}
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
              placeholder="name or folder/name"
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

        <p className="dialog-hint">
          Use <code>/</code> to save in a subfolder. Missing folders are created.
        </p>

        <p className="new-file-target" data-testid="new-file-target">
          {directory === null ? (
            "Finding your workflow folder…"
          ) : targetPath === null ? (
            "Saves to …"
          ) : (
            <>
              Saves to <code>{targetPath}</code>
              {isNewFolder && " (new folder)"}
            </>
          )}
        </p>

        {parsed.error !== null && (
          <p className="new-file-error" role="alert">
            {parsed.error}
          </p>
        )}

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
 * The filename field as a path relative to the picked directory: a trailing `.workflow.json` is
 * stripped and `/` separates subfolders, which the Server creates on save. A backslash, an empty
 * segment, or a segment starting with `.` (so `..`) is refused, so the path cannot leave the picked
 * directory.
 */
function parseStem(stem: string): { relative: string; error: string | null } {
  const relative = stem.trim().replace(/\.workflow\.json$/i, "");
  if (relative === "") return { relative, error: null };
  if (relative.includes("\\")) return { relative, error: "Use / to separate folders, not \\." };
  const segments = relative.split("/");
  if (segments.some((segment) => segment.trim() === ""))
    return { relative, error: "Folder and file names cannot be empty." };
  if (segments.some((segment) => segment.startsWith(".")))
    return { relative, error: "Names cannot start with a dot." };
  return { relative: segments.map((segment) => segment.trim()).join("/"), error: null };
}

/** `dirs` plus every ancestor directory of each (the project root, `""`, included). */
function withAncestors(dirs: readonly string[]): Set<string> {
  const all = new Set<string>([""]);
  for (const dir of dirs) {
    let current = dir;
    while (current !== "" && !all.has(current)) {
      all.add(current);
      current = dirnameOf(current);
    }
  }
  return all;
}

/** The `.workflow.json` path for the relative `stem`, under `directory` (root when empty) — the
 * save target. */
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
