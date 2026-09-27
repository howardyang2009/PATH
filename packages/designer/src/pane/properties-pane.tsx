import type { WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import type { EditCommit } from "../edit-key.js";
import { findById } from "../edit-tree.js";
import { FileProperties } from "./file-properties.js";
import { NodeProperties } from "./node-properties.js";

/**
 * The properties pane: a single-click on a canvas node populates it; an empty-canvas click (or a
 * node the active file no longer holds) shows the **file's own** properties. Layout is fixed
 * top-to-bottom: the node's **role** (only when its container gives one), a one-line kind
 * explanation, then `name`, `id` (a confirmation-gated re-key, ADR 0015), and the kind's own fields
 * expanded. The payload regions — a step's **config**, **input**, **context writes** and
 * **reference**, and the file's own equivalents — start collapsed, and each is keyed by its owner,
 * so a section resets to its default when the selection moves rather than opening a region the
 * author did not ask for.
 *
 * The step editors are the three tiers: hand-built for `prompt` / `binary` / `workflow`, a
 * generated form for any other registry type, and a live-validated raw-JSON floor for a payload no
 * form can lay out, so every in-registry type opens. The worker selector shows only when the type
 * ships more than one.
 */

export interface PropertiesPaneProps {
  file: WorkflowFile;
  /** The selected node's id, or `null` for the file's own properties. */
  selectedId: string | null;
  plugins: WireStepPlugin[];
  applyEdit: EditCommit<WorkflowFile>;
  /** Re-point the selection after a re-key changes a node's id (ADR 0015). */
  onReselect: (id: string) => void;
  /** Open the ref-target chooser for an empty `workflow` node; absent when the active file has no
   * path (a ref is stored relative to its file), in which case the plain path field is the
   * editor. */
  onAddRefTarget?: (nodeId: string) => void;
}

export function PropertiesPane({
  file,
  selectedId,
  plugins,
  applyEdit,
  onReselect,
  onAddRefTarget,
}: PropertiesPaneProps): JSX.Element {
  const node = selectedId === null ? null : findById(file.body, selectedId);
  if (node === null) {
    return <FileProperties file={file} plugins={plugins} applyEdit={applyEdit} />;
  }
  return (
    <NodeProperties
      file={file}
      node={node}
      plugins={plugins}
      applyEdit={applyEdit}
      onReselect={onReselect}
      onAddRefTarget={onAddRefTarget}
    />
  );
}
