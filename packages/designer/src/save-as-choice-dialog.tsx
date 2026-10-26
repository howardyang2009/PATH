import { useTranslations } from "use-intl";

/** Workflow mode's **Save as…** first asks: a copy as `*.workflow.json`, or a new template of its
 * body. Each choice opens its own dialog; Cancel closes this one and saves nothing. */
export function SaveAsChoiceDialog({
  onWorkflow,
  onTemplate,
  onCancel,
}: {
  onWorkflow: () => void;
  onTemplate: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useTranslations();
  return (
    <div
      className="dialog-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t("designer.saveAsChoiceDialog.title")}
    >
      <div className="dialog">
        <h2 className="dialog-title">{t("designer.saveAsChoiceDialog.title")}</h2>
        <p className="dialog-hint">{t("designer.saveAsChoiceDialog.hint")}</p>
        <div className="save-as-choices">
          <button type="button" className="save-as-choice" onClick={onWorkflow}>
            <span className="save-as-choice-label">
              {t("designer.saveAsChoiceDialog.workflow")}
            </span>
            <span className="save-as-choice-hint">
              {t("designer.saveAsChoiceDialog.workflowHint")}
            </span>
          </button>
          <button type="button" className="save-as-choice" onClick={onTemplate}>
            <span className="save-as-choice-label">
              {t("designer.saveAsChoiceDialog.template")}
            </span>
            <span className="save-as-choice-hint">
              {t("designer.saveAsChoiceDialog.templateHint")}
            </span>
          </button>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {t("designer.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
