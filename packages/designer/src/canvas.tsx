import type { RunStatus, WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import type { MouseEvent } from "react";
import { BlockTree, type DescendHandler } from "./block-tree.js";
import { ConflictProvider } from "./conflict-context.js";
import { createEditor, type EditorApi } from "./editor-api.js";
import { GotoProvider } from "./goto-context.js";
import { defaultLeafKind } from "./palette-data.js";
import { type Problem, problemMarks } from "./problems.js";
import { ProblemsPanel } from "./problems-panel.js";
import { basename } from "./resolve-ref.js";
import { useRunProjection } from "./run/run-projection.js";
import { RUN_STATUS_GLYPH } from "./run/run-status.js";
import { useSelection } from "./selection-context.js";
import type { Armed } from "./use-armed.js";
import { type Frame, frameDirty, type OpenSession } from "./use-open-file.js";

/** The canvas region: the centre surface a `path/workflow` body renders on. It shows one of: the empty
 * affordance, a registry/fetch problem, a legible refusal, or the block-grammar render under a breadcrumb. */
export function Canvas({
  session,
  plugins,
  armed,
  onArm,
  problems,
  onNew,
  onOpenExisting,
  onAuthorRef,
  workflowRunStatus,
}: {
  session: OpenSession;
  plugins: WireStepPlugin[];
  armed: Armed | null;
  onArm: (armed: Armed | null) => void;
  /** The active file's cross-node problems, derived once by the App and shared with the launch button's count. */
  problems: Problem[];
  /** Start a new workflow or a new template, by the session's mode — the empty canvas's first entry point. */
  onNew: () => void;
  /** Open the pick-an-existing dialog for the mode (a workflow or a template) — the second entry point. */
  onOpenExisting: () => void;
  /** Open the ref-target chooser for an unset `workflow` block; absent for a from-scratch root, which has
   *  no path to store a relative ref against and so leaves an empty-ref double-click inert. */
  onAuthorRef?: (nodeId: string) => void;
  /** The watched run's root-run status, badged on the workflow-name crumb; `null` when no run is watched. */
  workflowRunStatus: RunStatus | null;
}): JSX.Element {
  const { registry, frames, activeIndex, descend, goTo, applyEdit } = session;
  const selection = useSelection();

  // A double-click on a `workflow` block: a set ref descends across the boundary; an unset ref opens the
  // ref-target chooser instead, so a freshly swapped-in block is authorable rather than a dead descent
  // into `""`.
  const onDescend: DescendHandler = (node) => {
    if (node.ref) descend(node.ref, node.id);
    else onAuthorRef?.(node.id);
  };

  if (registry.phase === "loading") {
    return <CanvasNote title="Loading…" hint="Fetching the step-plugin registry." />;
  }
  if (registry.phase === "error") {
    return <CanvasNote title="Registry unavailable" hint={registry.message} />;
  }
  if (frames.length === 0) {
    const noun = session.mode === "template" ? "template" : "workflow";
    return (
      <CanvasNote
        title="Empty canvas"
        hint={`No ${noun} open. Start a new one, or open an existing ${noun} to edit it.`}
        action={
          <div className="canvas-empty-actions">
            <button type="button" className="new-file-start" onClick={onNew}>
              New {noun}
            </button>
            <button type="button" className="open-file-start" onClick={onOpenExisting}>
              Open {noun}
            </button>
          </div>
        }
      />
    );
  }

  const active = frames[activeIndex]!;
  return (
    <section className="canvas" aria-label="Workflow canvas">
      <Breadcrumb
        frames={frames}
        activeIndex={activeIndex}
        onCrumb={goTo}
        onSelectFile={selection?.onSelect}
        workflowRunStatus={workflowRunStatus}
      />
      <CanvasBody>
        <FrameView
          frame={active}
          onDescend={onDescend}
          applyEdit={applyEdit}
          plugins={plugins}
          armed={armed}
          onArm={onArm}
          problems={problems}
        />
      </CanvasBody>
    </section>
  );
}

/** The scrolling canvas body. A click that reaches it is the background — blocks stop the click's
 * propagation — so it deselects and the pane falls back to the file's own properties. */
function CanvasBody({ children }: { children: JSX.Element }): JSX.Element {
  const selection = useSelection();
  // Deselect only on a true background click: a control/socket button press must not also drop the selection.
  const onClick = (event: MouseEvent): void => {
    if ((event.target as HTMLElement).closest("button")) return;
    selection?.onSelect(null);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: background click-to-deselect is a pointer
    // biome-ignore lint/a11y/useKeyWithClickEvents: convenience; blocks carry the keyboard path.
    <div className="canvas-body" onClick={selection ? onClick : undefined}>
      {children}
    </div>
  );
}

/** The file breadcrumb: one crumb per trail frame. The active one is marked current, and clicking it
 * deselects so the pane falls back to the workflow's own properties. Frames on either side are buttons:
 * ancestors ascend, and a frame ahead of the active one is a forward re-entry back down the same trail. */
function Breadcrumb({
  frames,
  activeIndex,
  onCrumb,
  onSelectFile,
  workflowRunStatus,
}: {
  frames: Frame[];
  activeIndex: number;
  onCrumb: (index: number) => void;
  /** Deselect to the file's own properties, or `undefined` when the tree renders read-only (no selection wired). */
  onSelectFile?: (id: string | null) => void;
  /** The watched run's root-run status, badged on the **root** crumb; a nested descent crumb badges its
   *  own descent node's projected status instead, and `null` draws nothing on the root. */
  workflowRunStatus: RunStatus | null;
}): JSX.Element {
  // The projection folds each node's runs to one status. A descent crumb reads the status of the
  // `workflow` block it descended through — the sub-workflow's own verdict — so the trail badges every
  // level, e.g. `parent failed / child failed`, not only the root. Looked up once here; a per-id hook cannot loop.
  const projection = useRunProjection();
  return (
    <nav className="breadcrumb" aria-label="File breadcrumb">
      {frames.map((frame, index) => {
        const current = index === activeIndex;
        const label = frameLabel(frame);
        // The root crumb (index 0) badges the root run's status; a descent crumb badges its descent node's.
        const crumbStatus =
          index === 0
            ? workflowRunStatus
            : frame.descendedVia
              ? (projection?.get(frame.descendedVia) ?? null)
              : null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: trail position is the frame identity here.
          <span className="crumb-wrap" key={`${index}:${frame.path}`}>
            {index > 0 ? (
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
            ) : null}
            {current ? (
              // The current crumb is the open file's name; clicking it deselects (a no-op when nothing is wired).
              <button
                type="button"
                className="crumb crumb-current"
                aria-current="page"
                title={frame.path ?? undefined}
                onClick={onSelectFile ? () => onSelectFile(null) : undefined}
              >
                {label}
              </button>
            ) : (
              <button
                type="button"
                className="crumb"
                title={frame.path ?? undefined}
                onClick={() => onCrumb(index)}
              >
                {label}
              </button>
            )}
            {crumbStatus !== null ? <WorkflowRunBadge status={crumbStatus} /> : null}
          </span>
        );
      })}
    </nav>
  );
}

/** The workflow-level run projection on the breadcrumb: the watched run's root-run status as a glyph +
 * label badge on the workflow-name line. The implicit root run has no `nodeId`, so it lands on no canvas
 * node; this is where its verdict shows. `data-run-status` tints it from the stylesheet. */
function WorkflowRunBadge({ status }: { status: RunStatus }): JSX.Element {
  return (
    <span className="node-run-badge" data-run-status={status} data-testid="workflow-run-badge">
      <span className="node-run-badge-glyph" aria-hidden="true">
        {RUN_STATUS_GLYPH[status]}
      </span>
      {status}
    </span>
  );
}

/** A frame's breadcrumb label: the opened file's own `name`, else the file's basename. */
function frameLabel(frame: Frame): string {
  if (frame.state.phase === "open" && frame.state.result.status === "opened") {
    return frame.state.result.file.name;
  }
  // A frame without an opened file always has a path (loading / fetch-error); the from-scratch buffer is
  // always opened, so it takes the `name` branch above and never reaches here.
  return basename(frame.path ?? "");
}

/** Render one frame: loading, a fetch error, a refusal, or the opened (editable) block tree. */
function FrameView({
  frame,
  onDescend,
  applyEdit,
  plugins,
  armed,
  onArm,
  problems,
}: {
  frame: Frame;
  onDescend: DescendHandler;
  applyEdit: (next: WorkflowFile) => void;
  plugins: WireStepPlugin[];
  armed: Armed | null;
  onArm: (armed: Armed | null) => void;
  problems: Problem[];
}): JSX.Element {
  const { state } = frame;
  if (state.phase === "loading") {
    return <p className="pane-note">Loading {frame.path}…</p>;
  }
  if (state.phase === "fetch-error") {
    return <Refusal heading="Could not read the file" message={state.message} />;
  }

  const { result } = state;
  switch (result.status) {
    case "opened": {
      const editor = createEditor(
        result.file,
        applyEdit,
        armed,
        () => onArm(null),
        defaultLeafKind(plugins),
      );
      // Dirty is content-equality against the baseline, read through the one shared relation so it cannot
      // drift from launch/Save. Its note ("Unsaved edits") shows in the top bar, not here.
      const dirty = frameDirty(frame);
      // The App's single cross-node pass: its marker map feeds the per-node ⚠ and its flat list the panel.
      return (
        <div className="opened" data-dirty={dirty ? "true" : "false"}>
          <ConflictProvider value={problemMarks(problems)}>
            <GotoProvider file={result.file}>
              {result.file.body.length === 0 ? (
                <StartBody editor={editor} />
              ) : (
                <BlockTree
                  nodes={result.file.body}
                  onDescend={onDescend}
                  editor={editor}
                  socket={{ ownerId: null, flavor: "sequence" }}
                />
              )}
            </GotoProvider>
          </ConflictProvider>
          <ProblemsPanel problems={problems} />
        </div>
      );
    }
    case "unregistered-types":
      return <Refusal heading="Unregistered step types" message={result.message} />;
    case "duplicate-ids":
      return <Refusal heading="Duplicate node ids" message={result.message} />;
    case "invalid-ids":
      return <Refusal heading="Invalid node ids" message={result.message} />;
    case "invalid":
      return <Refusal heading="Cannot open the file" message={result.message} />;
  }
}

/** The empty-body affordance: a start-a-body prompt plus the file body's own open socket. Arm a kind in
 * the palette and the socket appears; click it to seed the body. */
function StartBody({ editor }: { editor: EditorApi }): JSX.Element {
  return (
    <section className="start-body" aria-label="Start a body">
      <p className="start-body-hint">
        Empty body. Pick a step or block from the palette to start it.
      </p>
      {editor.socketOpen("sequence", null) ? (
        <button
          type="button"
          className="socket socket-tail"
          onClick={() => editor.placeIntoList(null)}
        >
          + add {editor.armedLabel} here
        </button>
      ) : null}
    </section>
  );
}

/** A legible refusal banner. The message keeps its line breaks (the aggregate lists one offender per line). */
function Refusal({ heading, message }: { heading: string; message: string }): JSX.Element {
  return (
    <div className="refusal" role="alert">
      <p className="refusal-heading">{heading}</p>
      <pre className="refusal-body">{message}</pre>
    </div>
  );
}

/** The centred empty/loading affordance. It carries no `region`/`Workflow canvas` label — that landmark
 * belongs to the *open* canvas, so a test or screen reader waits for the real surface, not this placeholder. */
function CanvasNote({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: JSX.Element;
}): JSX.Element {
  return (
    <div className="canvas">
      <div className="canvas-empty">
        <p className="canvas-empty-title">{title}</p>
        <p className="canvas-empty-hint">{hint}</p>
        {action ?? null}
      </div>
    </div>
  );
}
