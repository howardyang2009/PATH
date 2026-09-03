import { useEffect, useState } from "react";
import type { PathApiClient } from "@path/client-core";

/**
 * The open-existing-workflow picker (#254, designer-spec § Opening a file). A modal list over the
 * project's discovered workflows (`GET /v0/workflows`); a choice hands its project-relative path back to
 * the App, which opens it as a fresh root through the session's `open`. This is the in-app peer of the
 * `?path=` deep-link — the same open pipeline (registry-relative parse, the ADR 0026/0015 gates), reached
 * without hand-typing a path — so an author can start a session and pick up any existing workflow to edit.
 *
 * The dialog owns only its own discovery load; the App decides what a pick does (discard the current stack
 * and open the chosen file), because that touches the whole session.
 */
export function OpenWorkflowDialog({
  client,
  onOpen,
  onCancel,
}: {
  client: PathApiClient;
  /** Open this already-discovered workflow at its project-relative path as a fresh root. */
  onOpen: (path: string) => void;
  /** Dismiss without opening anything; the current canvas stays as it was. */
  onCancel: () => void;
}): JSX.Element {
  // `null` until the discovery scan lands; an empty array is "none discovered". Best-effort: a failed scan
  // reads as an empty list here, so the dialog still opens with its "no workflows" note rather than hanging.
  const [paths, setPaths] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .listWorkflows()
      .then((response) => {
        if (alive) setPaths(response.workflows.map((wf) => wf.relative_path).sort());
      })
      .catch(() => {
        if (alive) setPaths([]);
      });
    return () => {
      alive = false;
    };
  }, [client]);

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label="Open a workflow">
      <div className="dialog open-workflow-dialog">
        <h2 className="dialog-title">Open a workflow</h2>
        <p className="dialog-hint">Choose a workflow from this project to open and edit.</p>
        {paths === null ? (
          <p className="pane-note">Discovering workflows…</p>
        ) : paths.length === 0 ? (
          <p className="ref-existing-empty">No workflows discovered in this project yet.</p>
        ) : (
          <ul className="ref-existing-list" aria-label="Discovered workflows">
            {paths.map((path) => (
              <li key={path}>
                <button type="button" className="ref-existing-item" onClick={() => onOpen(path)}>
                  {path}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
