import type { WorkflowSummary, WorkflowTreeNode } from "@path/client-core";
import {
  buildWorkflowTree,
  countWorkflowLeaves,
  isFolderOnOpenChain,
  nextOpenFolder,
  ORIGIN_FOLDER,
  workflowBaseName,
  workflowRowAction,
} from "@path/client-core";
import { useMessage } from "@path/i18n/react";
import { errorMessage, FolderRow, indent } from "@path/viewer";
import { useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { type DiscoveryLoad, discoveredWorkflows } from "./discovery.js";
import { READ_ONLY_TITLE } from "./read-only.js";

/**
 * The open-existing-workflow picker (designer-spec § Opening a file). A modal over the
 * project's discovered workflows (`GET /v0/workflows`); a choice hands its project-relative path
 * back to the App, which opens it as a fresh root through the session's `open`. This is the in-app
 * peer of the `?path=` deep-link — the same open pipeline (registry-relative parse, the ADR
 * 0026/0015 gates), reached without hand-typing a path — so an author can start a session and pick
 * up any existing workflow to edit.
 *
 * Discovery is presented as the same **folder tree** the Viewer's WORKFLOWS panel draws (the shared
 * `workflow-tree` seam): each level shows only its own children — the workflow files that sit
 * there, plus the folders that hold a workflow below — and a folder opens one-per-level as an
 * accordion. A folder click walks in; a file click opens that workflow. A shipped workflow is never
 * opened in place (ADR 0086): its row offers Copy to mine, and the App opens the copy. The dialog
 * owns only the tree's open-state and a failed copy's message; the App loads discovery
 * (`discovery.ts`) and decides what a pick does, because that touches the whole session.
 */
export function OpenWorkflowDialog({
  discovery,
  onOpen,
  onCopy,
  onCancel,
}: {
  discovery: DiscoveryLoad;
  /** Open this already-discovered workflow at its project-relative path as a fresh root. */
  onOpen: (path: string) => void;
  /** Copy the shipped workflow at this shipped path into the user's folder and open the copy. */
  onCopy: (shippedPath: string) => Promise<void>;
  /** Dismiss without opening anything; the current canvas stays as it was. */
  onCancel: () => void;
}): JSX.Element {
  // The deepest open folder path (accordion, one open folder per level; see `workflow-tree`).
  // The user's own workflows start open.
  const t = useTranslations();
  const renderMessage = useMessage();
  const [openFolder, setOpenFolder] = useState<string | null>(ORIGIN_FOLDER.user);
  // `null` until a scan lands, which reads as "still discovering". A failed scan with nothing
  // behind it reads as an empty list here, so the dialog still opens with its "no workflows" note.
  const workflows = discoveredWorkflows(discovery, { withCopies: true });
  const [copyError, setCopyError] = useState<string | null>(null);
  const copy = (shippedPath: string): void => {
    setCopyError(null);
    onCopy(shippedPath).catch((error: unknown) => setCopyError(renderMessage(errorMessage(error))));
  };

  const tree = useMemo(() => (workflows ? buildWorkflowTree(workflows) : []), [workflows]);

  return (
    <div
      className="dialog-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t("designer.openWorkflowDialog.title")}
    >
      <div className="dialog open-workflow-dialog">
        <h2 className="dialog-title">{t("designer.openWorkflowDialog.title")}</h2>
        <p className="dialog-hint">{t("designer.openWorkflowDialog.hint")}</p>
        {workflows === null ? (
          <p className="pane-note">{t("designer.dialog.discovering")}</p>
        ) : workflows.length === 0 ? (
          <p className="ref-existing-empty">{t("designer.dialog.noWorkflows")}</p>
        ) : (
          <div className="open-workflow-tree">
            <WorkflowTree
              nodes={tree}
              depth={0}
              label={t("designer.dialog.discoveredWorkflows")}
              openFolder={openFolder}
              onToggleFolder={(path) => setOpenFolder((prev) => nextOpenFolder(prev, path))}
              onOpen={onOpen}
              onCopy={copy}
            />
          </div>
        )}
        {copyError !== null ? (
          <p className="pane-note pane-error" role="alert">
            {copyError}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {t("designer.dialog.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
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
  onCopy,
}: {
  nodes: WorkflowTreeNode[];
  depth: number;
  /** Accessible name for this `<ul>`; only the top level carries one. */
  label?: string;
  openFolder: string | null;
  onToggleFolder: (path: string) => void;
  onOpen: (path: string) => void;
  onCopy: (shippedPath: string) => void;
}): JSX.Element {
  return (
    <ul className="workflows" aria-label={label}>
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <li key={`dir:${node.path}`}>
            <FolderRow
              name={node.name}
              path={node.path}
              count={countWorkflowLeaves(node)}
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
                onCopy={onCopy}
              />
            )}
          </li>
        ) : (
          <WorkflowLeaf
            key={node.workflow.relative_path}
            workflow={node.workflow}
            depth={depth}
            onOpen={onOpen}
            onCopy={onCopy}
          />
        ),
      )}
    </ul>
  );
}

/** One workflow file in the picker, as its row action reads (ADR 0086): a file to open (an invalid
 * one too, so the author can repair it), a shipped file to copy first, or only its load error. */
function WorkflowLeaf({
  workflow,
  depth,
  onOpen,
  onCopy,
}: {
  workflow: WorkflowSummary;
  depth: number;
  onOpen: (path: string) => void;
  onCopy: (shippedPath: string) => void;
}): JSX.Element {
  const t = useTranslations();
  const renderMessage = useMessage();
  const action = workflowRowAction(workflow, "edit");
  const path = workflow.relative_path;
  const name = workflowBaseName(path);
  if (action.kind === "open") {
    return (
      <li>
        <button
          type="button"
          className="workflow-row"
          onClick={() => onOpen(path)}
          style={indent(depth)}
        >
          <span className="workflow-file-name">{name}</span>
          {action.readOnly ? (
            <span className="workflow-tag" title={t(READ_ONLY_TITLE.shared)}>
              <span aria-hidden="true">🔒</span>
              {t("designer.readOnly.tag")}
            </span>
          ) : null}
        </button>
      </li>
    );
  }
  return (
    <li>
      <div className="workflow-row workflow-row--shipped" style={indent(depth)}>
        <span className="workflow-file-name">{name}</span>
        {action.kind === "copy" ? (
          <button
            type="button"
            aria-label={t("designer.openWorkflowDialog.copyNamed", { name })}
            onClick={() => onCopy(path)}
          >
            {t("designer.openWorkflowDialog.copy")}
          </button>
        ) : (
          <span className="pane-note pane-error">
            {action.error
              ? renderMessage(action.error)
              : t("designer.openWorkflowDialog.notLoaded")}
          </span>
        )}
      </div>
    </li>
  );
}
