import {
  isFolderOnOpenChain,
  nextOpenFolder,
  ORIGIN_FOLDER,
  type TemplateSummary,
} from "@path/client-core";
import { useMemo, useState } from "react";
import { FolderRow, indent } from "./open-existing-dialog.js";
import { READ_ONLY_TITLE } from "./read-only.js";
import { TEMPLATE_SUFFIX } from "./session-reducer.js";
import type { TemplateListLoad } from "./template-list.js";

interface TemplateFolder {
  kind: "folder";
  name: string;
  /** The full path from the top, the folder's identity and open-state key. */
  path: string;
  children: TemplateNode[];
}

type TemplateNode = TemplateFolder | { kind: "file"; template: TemplateSummary };

/**
 * Template mode's **Open…** picker: the project's templates (`GET /v0/templates`) as the same
 * folder tree the Open a workflow picker draws: one top folder per origin, then each template's own
 * subfolders, opening one folder per level. A choice opens that template's source in template mode,
 * the same as a double-click on its palette card. An invalid template is listed too, so an author
 * can open it and repair it.
 */
export function OpenTemplateDialog({
  templateList,
  onOpen,
  onCancel,
}: {
  templateList: TemplateListLoad;
  onOpen: (template: TemplateSummary) => void;
  onCancel: () => void;
}): JSX.Element {
  // The user's own templates start open.
  const [openFolder, setOpenFolder] = useState<string | null>(ORIGIN_FOLDER.user);
  const templates = templateList.phase === "ready" ? templateList.templates : null;
  const tree = useMemo(() => (templates ? buildTemplateTree(templates) : []), [templates]);

  return (
    <div className="dialog-scrim" role="dialog" aria-modal="true" aria-label="Open a template">
      <div className="dialog open-workflow-dialog">
        <h2 className="dialog-title">Open a template</h2>
        <p className="dialog-hint">Choose a template from this project to open and edit.</p>
        {templateList.phase === "loading" ? (
          <p className="pane-note">Loading templates…</p>
        ) : templateList.phase === "error" ? (
          <p className="new-file-error" role="alert">
            Could not list templates: {templateList.message}
          </p>
        ) : tree.length === 0 ? (
          <p className="ref-existing-empty">No templates</p>
        ) : (
          <div className="open-workflow-tree">
            <TemplateTree
              nodes={tree}
              depth={0}
              label="Templates"
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

/** Group templates into folders: the origin's folder, then the template's own subfolders. A
 * template with no id cannot be opened, so it is left out. */
function buildTemplateTree(templates: readonly TemplateSummary[]): TemplateNode[] {
  const root: TemplateFolder = { kind: "folder", name: "", path: "", children: [] };
  for (const template of templates) {
    if (template.id === null) continue;
    const segments = [ORIGIN_FOLDER[template.origin], ...(template.folder ?? "").split("/")];
    let cursor = root;
    let prefix = "";
    for (const segment of segments.filter((part) => part !== "")) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let folder = cursor.children.find(
        (child): child is TemplateFolder => child.kind === "folder" && child.name === segment,
      );
      if (!folder) {
        folder = { kind: "folder", name: segment, path: prefix, children: [] };
        cursor.children.push(folder);
      }
      cursor = folder;
    }
    cursor.children.push({ kind: "file", template });
  }
  sortLevel(root);
  return root.children;
}

/** Order each level folders-first, then files, each group alphabetical, recursively. */
function sortLevel(folder: TemplateFolder): void {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const an = a.kind === "folder" ? a.name : a.template.name;
    const bn = b.kind === "folder" ? b.name : b.template.name;
    return an.localeCompare(bn);
  });
  for (const child of folder.children) if (child.kind === "folder") sortLevel(child);
}

function countFiles(folder: TemplateFolder): number {
  return folder.children.reduce(
    (sum, child) => sum + (child.kind === "folder" ? countFiles(child) : 1),
    0,
  );
}

function TemplateTree({
  nodes,
  depth,
  label,
  openFolder,
  onToggleFolder,
  onOpen,
}: {
  nodes: TemplateNode[];
  depth: number;
  /** Accessible name for this `<ul>`; only the top level carries one. */
  label?: string;
  openFolder: string | null;
  onToggleFolder: (path: string) => void;
  onOpen: (template: TemplateSummary) => void;
}): JSX.Element {
  return (
    <ul className="workflows" aria-label={label}>
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <li key={`dir:${node.path}`}>
            <FolderRow
              name={node.name}
              count={countFiles(node)}
              depth={depth}
              open={isFolderOnOpenChain(openFolder, node.path)}
              onToggle={() => onToggleFolder(node.path)}
            />
            {isFolderOnOpenChain(openFolder, node.path) && (
              <TemplateTree
                nodes={node.children}
                depth={depth + 1}
                openFolder={openFolder}
                onToggleFolder={onToggleFolder}
                onOpen={onOpen}
              />
            )}
          </li>
        ) : (
          <li key={`${node.template.origin}:${node.template.id}`}>
            <button
              type="button"
              className="workflow-row"
              style={indent(depth)}
              onClick={() => onOpen(node.template)}
            >
              <span className="workflow-file-name">
                {node.template.name}
                {TEMPLATE_SUFFIX}
              </span>
              {node.template.read_only && node.template.origin === "shared" ? (
                <span className="workflow-tag" title={READ_ONLY_TITLE.shared}>
                  <span aria-hidden="true">🔒</span>read-only
                </span>
              ) : null}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
