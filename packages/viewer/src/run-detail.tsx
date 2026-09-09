import { isTerminal, type PathApiClient, type WorkflowFile } from "@path/client-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { CancelButton } from "./cancel-button.js";
import { Narrative } from "./narrative.js";
import { PaneError, PaneLoading } from "./pane-note.js";
import { ResumeFromButton } from "./resume-from-button.js";
import { RunTree } from "./run-tree.js";
import { StatusPill } from "./status-pill.js";
import type { RunViewLoad } from "./use-run-view.js";

/** Persisted run-tree height, in px. The narrative below takes whatever is left. */
const TREE_HEIGHT_KEY = "path.viewer.tree-height";
const DEFAULT_TREE_HEIGHT = 220;
const MIN_TREE_HEIGHT = 80;
/** Leave at least this much for the narrative so the tree can never swallow the whole pane. */
const MIN_NARRATIVE = 120;

function loadTreeHeight(): number {
  if (typeof localStorage === "undefined") return DEFAULT_TREE_HEIGHT;
  const raw = Number(localStorage.getItem(TREE_HEIGHT_KEY));
  return raw >= MIN_TREE_HEIGHT ? raw : DEFAULT_TREE_HEIGHT;
}

export interface RunDetailProps {
  client: PathApiClient;
  /** The live snapshot of the watched root run, owned by the app: one connection feeds two panes. */
  load: RunViewLoad;
  rootRunId: string;
  /** The run the node-I/O pane is showing, owned above so both panes agree on it. */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  /**
   * When provided, the `Resume from …` K-selection action renders above the run tree (ADR 0033),
   * handed the successor's fresh root run id on a resume. Omit it for a purely read-only embed.
   */
  onResumed?: (successorRootRunId: string) => void;
  /**
   * The open buffer's parsed file, for the eager legal-K check. The Designer passes its open buffer;
   * the Viewer holds no buffer and passes `null`, leaving the engine's `refusal` to backstop on click.
   */
  rootFile?: WorkflowFile | null;
  /** The open buffer's dirty flag — the Designer's save-first gate. Defaults to `false` (the Viewer). */
  dirty?: boolean;
}

/**
 * The run-detail read surface: root-run status plus the indented run tree, in the centre pane of
 * the pinned console (#44 Variant A), with the live narrative under it (#48). Status, tree and
 * narrative are all live off one connection — the view-model folds the SSE stream in as the run
 * executes, and reopening a run mid-flight replays its history (map #40's watch verb). That
 * connection is held by the app rather than by this pane, because the node-I/O pane reads the same
 * snapshot to know when the run it is showing has written its output.
 */
export function RunDetail({
  client,
  load,
  rootRunId,
  selectedRunId,
  onSelectRun,
  onResumed,
  rootFile = null,
  dirty = false,
}: RunDetailProps) {
  const detailRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState<number>(loadTreeHeight);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(TREE_HEIGHT_KEY, String(Math.round(treeHeight)));
    } catch {
      /* storage blocked — resize still works this session */
    }
  }, [treeHeight]);

  const clampTree = useCallback((px: number) => {
    // Never let the tree grow past what leaves the narrative its floor, nor below its own floor.
    const cap = (detailRef.current?.clientHeight ?? Infinity) - MIN_NARRATIVE;
    return Math.max(MIN_TREE_HEIGHT, Math.min(cap, px));
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setTreeHeight(clampTree(drag.startHeight + (e.clientY - drag.startY)));
    },
    [clampTree],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
  }, [onPointerMove]);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startHeight: treeHeight };
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag);
    },
    [treeHeight, onPointerMove, endDrag],
  );

  const onResizerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 32 : 8;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setTreeHeight((h) => clampTree(h - step));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setTreeHeight((h) => clampTree(h + step));
      }
    },
    [clampTree],
  );

  if (load.phase === "idle" || load.phase === "loading") return <PaneLoading what="run" />;
  if (load.phase === "error") return <PaneError what="run" message={load.message} />;

  const state = load.value;
  const root = state.runs.get(rootRunId);
  // A terminal run has nothing to cancel (#56) — the button is absent, not disabled-and-explaining.
  // The finished-side mirror, Resume, lives in the runs rail (under the selected row), not here.
  const cancellable = !isTerminal(state.status);

  return (
    <div className="run-detail" ref={detailRef}>
      {/* The K-selection action, above the run tree that drives it (spec: K is the run of the node
          selected in the tree). Rendered only when the surface supplies an `onResumed` — the Viewer
          and the Designer both do; a read-only embed omits it. Plain Resume/Delete stay on the runs
          rail's rows, keyed on a root-run row rather than the tree selection. */}
      {onResumed && (
        <ResumeFromButton
          client={client}
          rootRunId={rootRunId}
          runs={state.runs}
          rootFile={rootFile}
          selectedRunId={selectedRunId}
          dirty={dirty}
          onResumed={onResumed}
        />
      )}
      <header className="run-head" data-testid="run-head">
        <span className="run-workflow-name">{root?.workflowName ?? "—"}</span>
        <StatusPill status={state.status} />
        {cancellable && <CancelButton client={client} rootRunId={rootRunId} />}
        <dl className="run-meta-grid">
          <dt>workflow id</dt>
          <dd className="run-workflow-id">{root?.workflowId ?? "—"}</dd>
          <dt>workflow file</dt>
          <dd className="run-workflow-path">{root?.workflowPath ?? "—"}</dd>
        </dl>
      </header>

      <section
        className="run-section"
        aria-labelledby="run-tree-title"
        style={{ height: treeHeight }}
      >
        <header className="card-head">
          <h3 className="card-title" id="run-tree-title">
            Run tree
          </h3>
          <span className="card-count">{state.runs.size} runs</span>
        </header>
        <RunTree
          rootRunId={rootRunId}
          runs={state.runs}
          selectedRunId={selectedRunId}
          onSelectRun={onSelectRun}
        />
      </section>

      <div
        className="row-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize run tree"
        aria-valuenow={Math.round(treeHeight)}
        aria-valuemin={MIN_TREE_HEIGHT}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={onResizerKeyDown}
      />

      <Narrative events={state.narrative} stream={state.stream} />
    </div>
  );
}
