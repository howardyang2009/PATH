import { buildRunTree, nodeLabel, type RunNodeState, type RunTreeNode } from "@path/client-core";
import { useState } from "react";
import { RunStatusPill } from "./run-status.js";

/**
 * The run-inspector tree (surface 6, ADR 0025): an indented, collapsible parent/child list of the runs
 * under one root run. The canvas projection answers *where in my workflow is it*; this tree answers
 * *which of a node's runs* — a `while-do`'s iteration 3 vs 4, a `parallel`'s fan-out, a resume's reuse
 * row, a `workflow`-ref's child tree — none of which a single canvas node can show.
 *
 * What nests, and in what order, is `buildRunTree`'s (reused unchanged): parentage, orphan runs a tree
 * read has not placed yet, and execution order are facts about runs, not this list. What is left here is
 * the list — indentation, the collapse toggles, and selection.
 */
export interface RunTreeProps {
  rootRunId: string;
  runs: ReadonlyMap<string, RunNodeState>;
  /** The run whose I/O the inspector shows, if any. */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}

export function RunTree({ rootRunId, runs, selectedRunId, onSelectRun }: RunTreeProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());

  const root = buildRunTree(rootRunId, runs);
  if (!root) return <p className="run-note">No runs recorded for this root run.</p>;

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

function RunTreeRow({ node, tree }: { node: RunTreeNode; tree: TreeView }): JSX.Element {
  const { run, children } = node;
  const isCollapsed = tree.collapsed.has(run.runId);
  // The human step name is the row's headline; `nodeName`/`nodeId` are null together on the implicit
  // root run, where `nodeLabel` (shared) supplies the placeholder.
  const label = run.nodeName ?? nodeLabel(run.nodeId);

  return (
    <li className="run-tree-item" data-testid={`run-tree-item-${run.runId}`}>
      <div className="run-tree-line">
        {children.length > 0 ? (
          <button
            type="button"
            className="run-tree-toggle"
            data-testid={`run-tree-toggle-${run.runId}`}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
            onClick={() => tree.onToggle(run.runId)}
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="run-tree-toggle-spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className="run-tree-row"
          title={run.runId}
          data-run-id={run.runId}
          data-testid={`run-tree-row-${run.runId}`}
          aria-current={run.runId === tree.selectedRunId ? "true" : undefined}
          onClick={() => tree.onSelectRun(run.runId)}
        >
          <span className="run-tree-name">{label}</span>
          <RunStatusPill status={run.status} />
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
