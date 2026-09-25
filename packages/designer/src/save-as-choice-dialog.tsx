/**
 * Workflow mode's **Save as…** first asks what to save the open workflow as (#459.6): a copy as a new
 * `*.workflow.json` (the "Save workflow as" dialog), or a new step-template of its body (the "Save
 * workflow as step-template" dialog). Each choice opens its own dialog; Cancel closes this one and saves nothing.
 */
export function SaveAsChoiceDialog({
  onWorkflow,
  onTemplate,
  onCancel,
}: {
  onWorkflow: () => void;
  onTemplate: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label="Save as">
      <div className="dialog">
        <h2 className="dialog-title">Save as</h2>
        <p className="dialog-hint">Save a copy of this workflow. The open workflow is not changed on disk.</p>
        <div className="save-as-choices">
          <button type="button" className="save-as-choice" onClick={onWorkflow}>
            <span className="save-as-choice-label">Workflow…</span>
            <span className="save-as-choice-hint">A new *.workflow.json file. The editor then edits the copy.</span>
          </button>
          <button type="button" className="save-as-choice" onClick={onTemplate}>
            <span className="save-as-choice-label">Step-template…</span>
            <span className="save-as-choice-hint">A new step-template of the workflow's body. The workflow stays open.</span>
          </button>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
