import type { RunNodeState } from "@path/client-core";
import { useState } from "react";
import { nodeLabel } from "./node-label.js";
import { StatusPill } from "./status-pill.js";

/**
 * The run tree: an indented, collapsible parent/child list of the runs under one root run — the
 * shape pinned by map #40 (a node-graph canvas is designer territory, not this viewer). A
 * workflow-step's run spawns child runs (CONTEXT.md, workflow-as-step), so what nests here is the
 * run tree, not the workflow body: every row is a run, labelled by the node it ran.
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

  const root = runs.get(rootRunId);
  if (!root) return <p className="pane-note">No runs recorded for this root run.</p>;

  const tree: TreeView = {
    childrenByParent: indexChildren(rootRunId, runs),
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
      <RunTreeRow run={root} tree={tree} />
    </ul>
  );
}

/** Everything a row needs beyond its own run — one object rather than five parallel props. */
interface TreeView {
  childrenByParent: ReadonlyMap<string, RunNodeState[]>;
  collapsed: ReadonlySet<string>;
  selectedRunId: string | null;
  onToggle: (runId: string) => void;
  onSelectRun: (runId: string) => void;
}

function RunTreeRow({ run, tree }: { run: RunNodeState; tree: TreeView }) {
  const children = tree.childrenByParent.get(run.runId) ?? [];
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
            <RunTreeRow key={child.runId} run={child} tree={tree} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Group every non-root run under its parent, ordered oldest-first so the tree reads in execution
 * order. A run may name a parent the tree does not (yet) contain — the stream is ahead of the last
 * tree read — so it hangs off the root until the re-read places it, rather than vanishing from the
 * tree mid-run.
 */
function indexChildren(
  rootRunId: string,
  runs: ReadonlyMap<string, RunNodeState>,
): Map<string, RunNodeState[]> {
  const children = new Map<string, RunNodeState[]>();
  for (const run of runs.values()) {
    if (run.runId === rootRunId) continue;
    const parent = run.parentRunId !== null && runs.has(run.parentRunId) ? run.parentRunId : rootRunId;
    const siblings = children.get(parent);
    if (siblings) siblings.push(run);
    else children.set(parent, [run]);
  }
  for (const siblings of children.values()) siblings.sort(byStartOrder);
  return children;
}

/** Oldest start first; a run that has not started yet sorts last. Run id breaks ties. */
function byStartOrder(a: RunNodeState, b: RunNodeState): number {
  if (a.startedAt !== b.startedAt) {
    if (a.startedAt === null) return 1;
    if (b.startedAt === null) return -1;
    return a.startedAt < b.startedAt ? -1 : 1;
  }
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}
