import {
  awaitingNodeForRun,
  buildRunTree,
  isIterationRun,
  isPassRun,
  nodeLabel,
  type RunNodeState,
  type RunTreeNode,
  type WorkflowFile,
} from "@path/client-core";
import { useState } from "react";
import { AssigneeChip } from "./assignee-chip.js";
import { StatusPill } from "./status-pill.js";

/**
 * The run tree: an indented, collapsible parent/child list of the runs under one root run — the
 * shape pinned by map #40 (a node-graph canvas is designer territory, not this viewer). Every row
 * is a run, labelled by the node it ran.
 *
 * What nests, and in what order, is `buildRunTree`'s — parentage, orphan runs the last tree read
 * has not placed yet, and execution order are facts about runs, not about this list. What is left
 * here is the list: indentation, the collapse toggles, and selection.
 */
export interface RunTreeProps {
  rootRunId: string;
  runs: ReadonlyMap<string, RunNodeState>;
  /** The run whose I/O the node pane is showing, if any. */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  /**
   * The reachable workflow files (root + transitively-ref'd sub-files), for an awaiting leaf's assignee
   * chip — read from the node by id, which may sit in a nested file, not only the root.
   */
  workflowFiles?: readonly WorkflowFile[];
}

export function RunTree({
  rootRunId,
  runs,
  selectedRunId,
  onSelectRun,
  workflowFiles = [],
}: RunTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());

  const root = buildRunTree(rootRunId, runs);
  if (!root) return <p className="pane-note">No runs recorded for this root run.</p>;

  const tree: TreeView = {
    collapsed,
    selectedRunId,
    onSelectRun,
    workflowFiles,
    onToggle: (runId) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(runId)) next.add(runId);
        return next;
      }),
  };

  return (
    <ul className="run-tree">
      <RunTreeRow node={root} tree={tree} />
    </ul>
  );
}

/** Everything a row needs beyond its own node — one object rather than four parallel props. */
interface TreeView {
  collapsed: ReadonlySet<string>;
  selectedRunId: string | null;
  onToggle: (runId: string) => void;
  onSelectRun: (runId: string) => void;
  workflowFiles: readonly WorkflowFile[];
}

function RunTreeRow({ node, tree }: { node: RunTreeNode; tree: TreeView }) {
  const { run, children } = node;
  const isCollapsed = tree.collapsed.has(run.runId);
  // The human step name is the row's headline; the GUID `nodeId` and the `runId` trail it as the
  // two machine identities. `nodeName`/`nodeId` are null together on the implicit root run. A
  // `while-do` iteration container (ADR 0037) shares its loop's name across passes, so its 1-based
  // ordinal trails the name to tell one pass from the next. A goto pass container (ADR 0054) has no
  // name of its own: it reads `Pass N`, naming the goto that opened it after pass 1.
  const name = run.nodeName ?? nodeLabel(run.nodeId);
  const label = isPassRun(run)
    ? run.nodeName === null
      ? `Pass ${run.pass}`
      : `Pass ${run.pass} · opened by ${run.nodeName}`
    : isIterationRun(run)
      ? `${name} · iteration ${run.iteration}`
      : name;
  // An awaiting leaf shows its assignee as a chip in the rail (CONTEXT.md § Person-activity). The
  // assignee lives on the node in the file, not the run row, so it is read by id; absent when the file
  // is not loaded or the node has no assignee.
  const assignee = awaitingNodeForRun(tree.workflowFiles, run)?.assignee ?? null;
  // The display status the surfaces share comes off the tree node, which `buildRunTree` computed from
  // the same snapshot every other pane reads: a running run with an awaiting run below it reads
  // `awaiting` (view-only, ADR 0038). The chip above stays keyed on the real status, so only the actual
  // awaiting leaf carries an assignee — a flipped ancestor gets the pill, not a chip.
  const displayStatus = node.displayStatus;

  return (
    <li className="tree-item" data-testid={`tree-item-${run.runId}`}>
      <div className="tree-line">
        {children.length > 0 ? (
          <button
            type="button"
            className="tree-toggle"
            data-testid={`tree-toggle-${run.runId}`}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
            onClick={() => tree.onToggle(run.runId)}
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
        ) : (
          // A leaf keeps the toggle's width so sibling labels stay on one vertical rule.
          <span className="tree-toggle-spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className="tree-row"
          title={run.runId}
          data-run-id={run.runId}
          data-testid={`tree-row-${run.runId}`}
          aria-current={run.runId === tree.selectedRunId ? "true" : undefined}
          onClick={() => tree.onSelectRun(run.runId)}
        >
          <span className="node-name">{label}</span>
          {run.nodeId && <span className="tree-ref node-ref">({run.nodeId})</span>}
          <span className="tree-ref run-ref">{run.runId}</span>
          <StatusPill status={displayStatus} />
          {assignee !== null && <AssigneeChip assignee={assignee} />}
        </button>
      </div>
      {children.length > 0 && !isCollapsed && (
        <ul className="run-tree">
          {children.map((child) => (
            <RunTreeRow key={child.run.runId} node={child} tree={tree} />
          ))}
        </ul>
      )}
    </li>
  );
}
