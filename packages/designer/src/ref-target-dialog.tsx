import { useState } from "react";
import { useTranslations } from "use-intl";
import { type DiscoveryLoad, discoveredWorkflows } from "./discovery.js";

/**
 * The target chooser for a new `workflow`-ref. Because a ref stores a **path**, adding one either
 * points at a discovered workflow or creates a new one: the child descends at once as an unwritten,
 * path-less buffer, and its first save picks the path and back-fills the parent ref. The dialog
 * owns only its mode; the App wires what each choice does.
 */
export function RefTargetDialog({
  discovery,
  excludePath,
  onPickExisting,
  onCreateNew,
  onCancel,
}: {
  discovery: DiscoveryLoad;
  /** The referring file's own path, dropped from the existing-picker so it cannot reference
   * itself. */
  excludePath: string;
  /** Point the ref at an already-discovered workflow at this project-relative path. */
  onPickExisting: (targetPath: string) => void;
  /** Descend into a fresh, unwritten child now; its first save picks the path and back-fills the
   * ref. */
  onCreateNew: () => void;
  /** Dismiss without setting the ref; the empty `workflow` node stays as it was. */
  onCancel: () => void;
}): JSX.Element {
  const t = useTranslations();
  const [mode, setMode] = useState<"choose" | "existing">("choose");

  if (mode === "existing") {
    return (
      <ExistingPicker
        discovery={discovery}
        excludePath={excludePath}
        onPick={onPickExisting}
        onBack={() => setMode("choose")}
        onCancel={onCancel}
      />
    );
  }

  return (
    <div
      className="dialog-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t("designer.refTargetDialog.title")}
    >
      <div className="dialog ref-target-dialog">
        <h2 className="dialog-title">{t("designer.refTargetDialog.title")}</h2>
        <p className="dialog-hint">{t("designer.refTargetDialog.hint")}</p>
        <div className="ref-target-choices">
          <button type="button" className="ref-target-existing" onClick={() => setMode("existing")}>
            {t("designer.refTargetDialog.existing")}
          </button>
          <button type="button" className="ref-target-new" onClick={onCreateNew}>
            {t("designer.refTargetDialog.createNew")}
          </button>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {t("designer.dialog.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The reference-existing branch: a picker over the project's discovered workflows (`GET
 * /v0/workflows`). */
function ExistingPicker({
  discovery,
  excludePath,
  onPick,
  onBack,
  onCancel,
}: {
  discovery: DiscoveryLoad;
  excludePath: string;
  onPick: (targetPath: string) => void;
  onBack: () => void;
  onCancel: () => void;
}): JSX.Element {
  // `null` until a scan lands: still discovering. A failed scan with nothing behind it reads as
  // empty, so the picker shows its "no workflows" note rather than an indefinite spinner.
  const t = useTranslations();
  const discovered = discoveredWorkflows(discovery);
  const paths =
    discovered === null
      ? null
      : discovered
          .map((wf) => wf.relative_path)
          .filter((path) => path !== excludePath)
          .sort();

  return (
    <div
      className="dialog-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t("designer.refTargetDialog.existing")}
    >
      <div className="dialog ref-existing-dialog">
        <h2 className="dialog-title">{t("designer.refTargetDialog.existing")}</h2>
        <p className="dialog-hint">{t("designer.refTargetDialog.existingHint")}</p>
        {paths === null ? (
          <p className="pane-note">{t("designer.dialog.discovering")}</p>
        ) : paths.length === 0 ? (
          <p className="ref-existing-empty">{t("designer.dialog.noWorkflows")}</p>
        ) : (
          <ul className="ref-existing-list" aria-label={t("designer.dialog.discoveredWorkflows")}>
            {paths.map((path) => (
              <li key={path}>
                <button type="button" className="ref-existing-item" onClick={() => onPick(path)}>
                  {path}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onBack}>
            {t("designer.dialog.back")}
          </button>
          <button type="button" onClick={onCancel}>
            {t("designer.dialog.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
