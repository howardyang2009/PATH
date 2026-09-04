import { useEffect, useMemo, useState } from "react";
import type {
  PathApiClient,
  WorkflowSummary,
  WorkflowTreeFolder,
  WorkflowTreeNode,
} from "@path/client-core";
import {
  buildWorkflowTree,
  countWorkflowLeaves,
  isFolderOnOpenChain,
  nextOpenFolder,
  workflowBaseName,
} from "@path/client-core";

/**
 * The open-existing-workflow picker (#254, designer-spec § Opening a file). A modal over the
 * project's discovered workflows (`GET /v0/workflows`); a choice hands its project-relative path back to
 * the App, which opens it as a fresh root through the session's `open`. This is the in-app peer of the
 * `?path=` deep-link — the same open pipeline (registry-relative parse, the ADR 0026/0015 gates), reached
 * without hand-typing a path — so an author can start a session and pick up any existing workflow to edit.
 *
 * Discovery is presented as the same **folder tree** the Viewer's WORKFLOWS panel draws (the shared
 * `workflow-tree` seam): each level shows only its own children — the workflow files that sit there,
 * plus the folders that hold a workflow below — and a folder opens one-per-level as an accordion. A
 * folder click walks in; a file click opens that workflow. The dialog owns only its own discovery load
 * and the tree's open-state; the App decides what a pick does (discard the current stack and open the
 * chosen file), because that touches the whole session.
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
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  // The deepest open folder path (accordion, one open folder per level; see `workflow-tree`).
  const [openFolder, setOpenFolder] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .listWorkflows()
      .then((response) => {
        if (alive) setWorkflows(response.workflows);
      })
      .catch(() => {
        if (alive) setWorkflows([]);
      });
    return () => {
      alive = false;
    };
  }, [client]);

  const tree = useMemo(() => (workflows ? buildWorkflowTree(workflows) : []), [workflows]);

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label="Open a workflow">
      <div className="dialog open-workflow-dialog">
        <h2 className="dialog-title">Open a workflow</h2>
        <p className="dialog-hint">Choose a workflow from this project to open and edit.</p>
        {workflows === null ? (
          <p className="pane-note">Discovering workflows…</p>
        ) : workflows.length === 0 ? (
          <p className="ref-existing-empty">No workflows discovered in this project yet.</p>
        ) : (
          <div className="open-workflow-tree">
            <WorkflowTree
              nodes={tree}
              depth={0}
              label="Discovered workflows"
              openFolder={openFolder}
              onToggleFolder={(path) => setOpenFolder((prev) => nextOpenFolder(prev, path))}
              onOpen={onOpen}
            />
          </div>
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

/** The left indent of one tree row at `depth`, in px — a folder step per level, over the row's base pad. */
function indent(depth: number): React.CSSProperties {
  return { paddingLeft: 8 + depth * 14 };
}

/**
 * One level of the folder tree: its folders first (each a navigation step that expands the next
 * level below it), then its workflow files (each opens that workflow). Recurses into an open
 * folder's children, so the tree walks down one folder per level.
 */
function WorkflowTree({
  nodes,
  depth,
  label,
  openFolder,
  onToggleFolder,
  onOpen,
}: {
  nodes: WorkflowTreeNode[];
  depth: number;
  /** Accessible name for this `<ul>`; only the top level carries one. */
  label?: string;
  openFolder: string | null;
  onToggleFolder: (path: string) => void;
  onOpen: (path: string) => void;
}): JSX.Element {
  return (
    <ul className="workflows" aria-label={label}>
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <li key={`dir:${node.path}`}>
            <FolderRow
              folder={node}
              depth={depth}
              open={isFolderOnOpenChain(openFolder, node.path)}
              onToggle={() => onToggleFolder(node.path)}
            />
            {isFolderOnOpenChain(openFolder, node.path) && (
              <WorkflowTree
                nodes={node.children}
                depth={depth + 1}
                openFolder={openFolder}
                onToggleFolder={onToggleFolder}
                onOpen={onOpen}
              />
            )}
          </li>
        ) : (
          <li key={node.workflow.relative_path}>
            <button
              type="button"
              className="workflow-row"
              onClick={() => onOpen(node.workflow.relative_path)}
              style={indent(depth)}
            >
              <span className="workflow-file-name">
                {workflowBaseName(node.workflow.relative_path)}
              </span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

/** One folder in the tree: a navigation step. Clicking it walks in (expands its level) or back out. */
function FolderRow({
  folder,
  depth,
  open,
  onToggle,
}: {
  folder: WorkflowTreeFolder;
  depth: number;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="workflow-folder-row"
      aria-expanded={open}
      onClick={onToggle}
      style={indent(depth)}
    >
      <span className="workflow-folder-chevron" aria-hidden="true">
        {open ? "▾" : "▸"}
      </span>
      <span className="workflow-folder-name">{folder.name}</span>
      <span className="workflow-folder-count">{countWorkflowLeaves(folder)}</span>
    </button>
  );
}
