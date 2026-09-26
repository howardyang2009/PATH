import { useState } from "react";
import { type DiscoveryLoad, discoveredWorkflows } from "./discovery.js";

/**
 * The target chooser for a new `workflow`-ref (#391, designer-spec § Nested `workflow`-ref creation).
 * Because a ref stores a **path**, adding one offers two ways to fill it:
 *
 * - **Reference an existing workflow** — a picker over the project's discovered workflows (the App's one
 *   `discovery.ts` snapshot); the choice is the target path.
 * - **Create a new workflow** — descend at once into a fresh, unwritten, path-less child buffer. No path is
 *   chosen here: the child's first save picks it and back-fills the parent ref from it, so authoring comes
 *   first and the ref follows the save.
 *
 * The dialog owns only its mode; the App wires what each choice does (set the ref, descend the new child),
 * because those touch the open file and the navigation trail.
 */
export function RefTargetDialog({
  discovery,
  excludePath,
  onPickExisting,
  onCreateNew,
  onCancel,
}: {
  discovery: DiscoveryLoad;
  /** The referring file's own path, dropped from the existing-picker so it cannot reference itself. */
  excludePath: string;
  /** Point the ref at an already-discovered workflow at this project-relative path. */
  onPickExisting: (targetPath: string) => void;
  /** Descend into a fresh, unwritten child now; its first save picks the path and back-fills the ref. */
  onCreateNew: () => void;
  /** Dismiss without setting the ref; the empty `workflow` node stays as it was. */
  onCancel: () => void;
}): JSX.Element {
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
      aria-label="Add a workflow reference"
    >
      <div className="dialog ref-target-dialog">
        <h2 className="dialog-title">Add a workflow reference</h2>
        <p className="dialog-hint">
          Point this reference at an existing workflow, or create a new one to author now.
        </p>
        <div className="ref-target-choices">
          <button type="button" className="ref-target-existing" onClick={() => setMode("existing")}>
            Reference an existing workflow
          </button>
          <button type="button" className="ref-target-new" onClick={onCreateNew}>
            Create a new workflow
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

/** The reference-existing branch: a picker over the project's discovered workflows (`GET /v0/workflows`). */
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
  // `null` until a scan lands: still discovering. A failed scan with nothing behind it reads as empty, so
  // the picker shows its "no workflows" note rather than an indefinite spinner.
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
      aria-label="Reference an existing workflow"
    >
      <div className="dialog ref-existing-dialog">
        <h2 className="dialog-title">Reference an existing workflow</h2>
        <p className="dialog-hint">Choose the workflow this reference runs as a nested run.</p>
        {paths === null ? (
          <p className="pane-note">Discovering workflows…</p>
        ) : paths.length === 0 ? (
          <p className="ref-existing-empty">No workflows discovered in this project yet.</p>
        ) : (
          <ul className="ref-existing-list" aria-label="Discovered workflows">
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
            Back
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
