import type { Message } from "@path/i18n";
import { useMessage } from "@path/i18n/react";
import { useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import {
  type DiscoveryLoad,
  discoveredRoots,
  discoveredSharedRoot,
  discoveredWorkflows,
} from "./discovery.js";
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
  title,
  initialDirectory,
  pickOrigin = false,
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
  /** Show the mine / shared picker (Save as…): it defaults to mine and confines the directory to the
   * picked side, mine being every directory outside the shared root. */
  pickOrigin?: boolean;
  /** Run the exclusive create against the composed path; the dialog reads its outcome. */
  create: (targetPath: string) => Promise<SaveAsResult>;
  /** Called once the file is created — the App drops the dialog and the frame is now saved. */
  onCreated: (path: string) => void;
  /** Dismiss without saving; the from-scratch buffer stays on the canvas untouched. */
  onCancel: () => void;
}): JSX.Element {
  const t = useTranslations("designer");
  const renderMessage = useMessage();
  const heading = title ?? t("newFileDialog.title");
  const roots = discoveredRoots(discovery);
  const sharedRoot = discoveredSharedRoot(discovery);
  const [origin, setOrigin] = useState<"user" | "shared">("user");
  const [picked, setDirectory] = useState<string | undefined>(undefined);
  const isShared = (dir: string): boolean =>
    sharedRoot !== undefined && (dir === sharedRoot || dir.startsWith(`${sharedRoot}/`));
  const onPickedSide = (dir: string): boolean =>
    !pickOrigin || isShared(dir) === (origin === "shared");
  // `null` until a directory is picked or discovery lands a root to default to.
  const directory =
    [picked, initialDirectory, ...roots].find((dir) => dir !== undefined && onPickedSide(dir)) ??
    null;
  const [stem, setStem] = useState(workflowName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Message | null>(null);

  // The picker's directories: the Server's writable roots plus the parent of every discovered
  // workflow (ADR 0085), and the preselected one.
  const directories = useMemo(() => {
    const dirs = new Set<string>(discoveredRoots(discovery));
    if (initialDirectory !== undefined) dirs.add(initialDirectory);
    for (const wf of discoveredWorkflows(discovery) ?? []) dirs.add(dirnameOf(wf.relative_path));
    return [...dirs].sort();
  }, [discovery, initialDirectory]);
  const shownDirectories = directories.filter(onPickedSide);

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
        setError({ key: "designer.newFileDialog.exists" });
      } else {
        setError(result.message);
      }
    });
  };

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label={heading}>
      <div className="dialog new-file-dialog">
        <h2 className="dialog-title">{heading}</h2>
        <p className="dialog-hint">{t("newFileDialog.hint")}</p>

        {pickOrigin ? (
          <label className="dialog-field">
            <span className="dialog-label">{t("newFileDialog.saveTo")}</span>
            <select
              className="new-file-directory"
              aria-label={t("newFileDialog.saveTo")}
              value={origin}
              onChange={(event) => {
                setOrigin(event.target.value === "shared" ? "shared" : "user");
                setDirectory(undefined);
              }}
            >
              <option value="user">{t("newFileDialog.mine")}</option>
              <option value="shared">{t("newFileDialog.shared")}</option>
            </select>
          </label>
        ) : null}

        <label className="dialog-field">
          <span className="dialog-label">{t("newFileDialog.directory")}</span>
          <select
            className="new-file-directory"
            aria-label={t("newFileDialog.directory")}
            value={directory ?? ""}
            disabled={directory === null}
            onChange={(event) => setDirectory(event.target.value)}
          >
            {shownDirectories.map((dir) => (
              <option key={dir} value={dir}>
                {dir === "" ? t("newFileDialog.projectRoot") : dir}
              </option>
            ))}
          </select>
        </label>

        <label className="dialog-field">
          <span className="dialog-label">{t("newFileDialog.filename")}</span>
          <span className="new-file-name">
            <input
              className="new-file-stem"
              aria-label={t("newFileDialog.filename")}
              placeholder={t("saveDialog.placeholder")}
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
          {t.rich("saveDialog.subfolderHint", { code: (chunks) => <code>{chunks}</code> })}
        </p>

        <p className="new-file-target" data-testid="new-file-target">
          {directory === null
            ? t("newFileDialog.finding")
            : targetPath === null
              ? t("newFileDialog.savesToPending")
              : t.rich(isNewFolder ? "newFileDialog.savesToNewFolder" : "newFileDialog.savesTo", {
                  path: targetPath,
                  code: (chunks) => <code>{chunks}</code>,
                })}
        </p>

        {parsed.error !== null && (
          <p className="new-file-error" role="alert">
            {t(`newFileDialog.${parsed.error}`)}
          </p>
        )}

        {error !== null && (
          <p className="new-file-error" role="alert">
            {renderMessage(error)}
          </p>
        )}

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

/** Why a filename is refused: the name of its message under `designer.newFileDialog`. */
type StemError = "backslash" | "emptySegment" | "dotSegment";

/**
 * The filename field as a path relative to the picked directory: a trailing `.workflow.json` is
 * stripped and `/` separates subfolders, which the Server creates on save. A backslash, an empty
 * segment, or a segment starting with `.` (so `..`) is refused, so the path cannot leave the picked
 * directory.
 */
function parseStem(stem: string): { relative: string; error: StemError | null } {
  const relative = stem.trim().replace(/\.workflow\.json$/i, "");
  if (relative === "") return { relative, error: null };
  if (relative.includes("\\")) return { relative, error: "backslash" };
  const segments = relative.split("/");
  if (segments.some((segment) => segment.trim() === "")) return { relative, error: "emptySegment" };
  if (segments.some((segment) => segment.startsWith("."))) return { relative, error: "dotSegment" };
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
