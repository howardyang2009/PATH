import { useEffect, useState } from "react";
import type { PathApiClient } from "@path/client-core";
import { NewFileDialog } from "./new-file-dialog.js";
import type { SaveNewFileResult } from "./use-open-file.js";

/**
 * The target chooser for a new `workflow`-ref (#391, designer-spec § Nested `workflow`-ref creation).
 * Because a ref stores a **path**, adding one offers two ways to fill it:
 *
 * - **Reference an existing workflow** — a picker over the project's discovered workflows; the choice is
 *   the target path.
 * - **Create a new workflow** — reuses the #390 new-file dialog to **choose the child's path** (directory
 *   picker + name + exclusive-create check). No stub file is written here; the parent ref is set to that
 *   path and the author descends into a fresh, unwritten child buffer, saved later with built content.
 *
 * The dialog owns only its mode; the App wires what each choice does (set the ref, descend the new child),
 * because those touch the open file and the navigation trail.
 */
export function RefTargetDialog({
  client,
  excludePath,
  onPickExisting,
  onCreateNew,
  checkPathFree,
  onCancel,
}: {
  client: PathApiClient;
  /** The referring file's own path, dropped from the existing-picker so it cannot reference itself. */
  excludePath: string;
  /** Point the ref at an already-discovered workflow at this project-relative path. */
  onPickExisting: (targetPath: string) => void;
  /** Point the ref at this new, project-relative child path and descend into its fresh buffer. */
  onCreateNew: (childPath: string) => void;
  /**
   * The non-writing exclusive-create check the new-file dialog runs against a chosen child path: `exists`
   * when a workflow already occupies it, `created` (no bytes written) when it is free. The authoritative
   * create still happens at the child's own first save.
   */
  checkPathFree: (targetPath: string) => Promise<SaveNewFileResult>;
  /** Dismiss without setting the ref; the empty `workflow` node stays as it was. */
  onCancel: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<"choose" | "existing">("choose");

  // The "create new" branch is the #390 dialog verbatim, only its `create` is the non-writing path check
  // and its success descends the child rather than closing a saved file.
  const [creating, setCreating] = useState(false);
  if (creating) {
    return <NewFileDialog client={client} workflowName="untitled" create={checkPathFree} onCreated={onCreateNew} onCancel={onCancel} />;
  }

  if (mode === "existing") {
    return <ExistingPicker client={client} excludePath={excludePath} onPick={onPickExisting} onBack={() => setMode("choose")} onCancel={onCancel} />;
  }

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label="Add a workflow reference">
      <div className="dialog ref-target-dialog">
        <h2 className="dialog-title">Add a workflow reference</h2>
        <p className="dialog-hint">Point this reference at an existing workflow, or create a new one to author now.</p>
        <div className="ref-target-choices">
          <button type="button" className="ref-target-existing" onClick={() => setMode("existing")}>
            Reference an existing workflow
          </button>
          <button type="button" className="ref-target-new" onClick={() => setCreating(true)}>
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
  client,
  excludePath,
  onPick,
  onBack,
  onCancel,
}: {
  client: PathApiClient;
  excludePath: string;
  onPick: (targetPath: string) => void;
  onBack: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [paths, setPaths] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .listWorkflows()
      .then((response) => {
        if (!alive) return;
        setPaths(response.workflows.map((wf) => wf.relative_path).filter((path) => path !== excludePath).sort());
      })
      .catch(() => {
        if (alive) setPaths([]);
      });
    return () => {
      alive = false;
    };
  }, [client, excludePath]);

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label="Reference an existing workflow">
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
