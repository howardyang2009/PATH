import { buildRunTree, type RunNodeState, type RunTreeNode } from "@path/client-core";
import { useState } from "react";
import { nodeLabel } from "./node-label.js";
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
}

export function RunTree({ rootRunId, runs, selectedRunId, onSelectRun }: RunTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());

  const root = buildRunTree(rootRunId, runs);
  if (!root) return <p className="pane-note">No runs recorded for this root run.</p>;

  const tree: TreeView = {
    collapsed,
    selectedRunId,
    onSelectRun,
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
}

function RunTreeRow({ node, tree }: { node: RunTreeNode; tree: TreeView }) {
  const { run, children } = node;
  const isCollapsed = tree.collapsed.has(run.runId);
  const label = nodeLabel(run.nodeId);

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
          <span className="node-id">{label}</span>
          <StatusPill status={run.status} />
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
