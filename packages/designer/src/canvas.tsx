import type { MouseEvent } from "react";
import type { WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { BlockTree } from "./block-tree.js";
import { ConflictProvider } from "./conflict-context.js";
import { createEditor, type EditorApi } from "./editor-api.js";
import { fileProblems, problemMarks, refLookupFor } from "./problems.js";
import { ProblemsPanel } from "./problems-panel.js";
import { canonicalSerialize } from "./serialize.js";
import { defaultLeafKind } from "./palette-data.js";
import { basename } from "./resolve-ref.js";
import { useSelection } from "./selection-context.js";
import { frameDirty, type Frame, type OpenSession } from "./use-open-file.js";

/**
 * The canvas region: the centre surface a `path/workflow` body renders on. Read-only in #367;
 * **editable** in #368 (designer-spec § Canvas interaction model). It shows one of: the empty affordance
 * when nothing is open, a registry/fetch problem, a legible refusal (ADR 0026 / ADR 0015), or the
 * block-grammar render under a breadcrumb — now with the palette's armed kind driving which sockets
 * open, and structure edits committed through the session's `applyEdit`.
 */
export function Canvas({
  session,
  plugins,
  armedKind,
  onArm,
  knownPaths,
  onOpenExisting,
}: {
  session: OpenSession;
  plugins: WireStepPlugin[];
  armedKind: string | null;
  onArm: (kind: string | null) => void;
  /** Discovered workflow paths (#392), so the render can flag a `workflow`-ref whose target is unsaved;
   *  `null` before the first discovery scan lands, which suppresses the check. */
  knownPaths: ReadonlySet<string> | null;
  /** Open the pick-an-existing-workflow dialog (#254) — the empty canvas's second entry point beside "New". */
  onOpenExisting: () => void;
}): JSX.Element {
  const { registry, frames, activeIndex, descend, goTo, applyEdit } = session;

  if (registry.phase === "loading") {
    return <CanvasNote title="Loading…" hint="Fetching the step-plugin registry." />;
  }
  if (registry.phase === "error") {
    return <CanvasNote title="Registry unavailable" hint={registry.message} />;
  }
  if (frames.length === 0) {
    return (
      <CanvasNote
        title="Empty canvas"
        hint="No workflow open. Start a new one, or open an existing workflow to edit it."
        action={
          <div className="canvas-empty-actions">
            <button type="button" className="new-file-start" onClick={session.newFile}>
              New workflow
            </button>
            <button type="button" className="open-file-start" onClick={onOpenExisting}>
              Open workflow
            </button>
          </div>
        }
      />
    );
  }

  const active = frames[activeIndex]!;
  return (
    <div className="canvas" role="region" aria-label="Workflow canvas">
      <Breadcrumb frames={frames} activeIndex={activeIndex} onCrumb={goTo} />
      <CanvasBody>
        <FrameView frame={active} onDescend={descend} applyEdit={applyEdit} plugins={plugins} armedKind={armedKind} onArm={onArm} knownPaths={knownPaths} />
      </CanvasBody>
    </div>
  );
}

/**
 * The scrolling canvas body. A click that reaches it — i.e. the background, not a block, which stops
 * the click's propagation — deselects, so the properties pane falls back to the file's own properties
 * (#369, § Pane layout: an empty-canvas click shows the file's own properties).
 */
function CanvasBody({ children }: { children: JSX.Element }): JSX.Element {
  const selection = useSelection();
  // Deselect only on a true background click. A block stops its own click's propagation, so what
  // reaches here is either the bare background or a bubbled control/socket button press — and a
  // structure edit (reorder, delete, add) must not also drop the selection, so ignore button clicks.
  const onClick = (event: MouseEvent): void => {
    if ((event.target as HTMLElement).closest("button")) return;
    selection?.onSelect(null);
  };
  return (
    <div className="canvas-body" onClick={selection ? onClick : undefined}>
      {children}
    </div>
  );
}

/**
 * The file breadcrumb: one crumb per trail frame, the **active** one (`activeIndex`) inert and marked
 * current. Frames on either side are buttons — ancestors ascend, and a frame ahead of the active one (kept
 * alive because an ascend no longer discards it, #391) is a forward re-entry back down the same trail.
 */
function Breadcrumb({ frames, activeIndex, onCrumb }: { frames: Frame[]; activeIndex: number; onCrumb: (index: number) => void }): JSX.Element {
  return (
    <nav className="breadcrumb" aria-label="File breadcrumb">
      {frames.map((frame, index) => {
        const current = index === activeIndex;
        const label = frameLabel(frame);
        return (
          <span className="crumb-wrap" key={`${index}:${frame.path}`}>
            {index > 0 ? <span className="crumb-sep" aria-hidden="true">/</span> : null}
            {current ? (
              <span className="crumb crumb-current" aria-current="page" title={frame.path ?? undefined}>
                {label}
              </span>
            ) : (
              <button type="button" className="crumb" title={frame.path ?? undefined} onClick={() => onCrumb(index)}>
                {label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
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
  armedKind,
  onArm,
  knownPaths,
}: {
  frame: Frame;
  onDescend: (ref: string) => void;
  applyEdit: (next: WorkflowFile) => void;
  plugins: WireStepPlugin[];
  armedKind: string | null;
  onArm: (kind: string | null) => void;
  knownPaths: ReadonlySet<string> | null;
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
      const editor = createEditor(result.file, applyEdit, armedKind, () => onArm(null), defaultLeafKind(plugins));
      // Dirty is content-equality against the baseline (ADR 0030), read through the one shared relation so
      // the badge cannot drift from launch/Save. `pristine` (the buffer still equals its bytes at the last
      // save-point) separates an id-stamp-only dirty from an authored edit, so the badge names the reason a
      // never-edited file is already dirty.
      const dirty = frameDirty(frame);
      const pristine = canonicalSerialize(result.file) === frame.openedBytes;
      const badge = !dirty ? null : result.idsStamped && pristine ? "Ids stamped on import — unsaved (ADR 0015)." : "Unsaved edits.";
      // The cross-node pass runs once per render (#388): its marker map feeds the per-node ⚠ and its
      // flat list feeds the problems panel — two coupled surfaces onto one derivation of the file. A
      // path-bearing frame also carries a ref lookup (#392) so a dangling `workflow`-ref is flagged; a
      // pathless frame (a from-scratch root, or a create-new child before its first save) has no directory
      // to resolve a relative ref from, and a not-yet-loaded discovery (`null`) suppresses it — the shared
      // `refLookupFor` folds both into `undefined`.
      const problems = fileProblems(result.file, refLookupFor(frame.path, knownPaths));
      return (
        <div className="opened" data-dirty={dirty ? "true" : "false"}>
          {badge ? (
            <p className="dirty-badge" role="status">
              {badge}
            </p>
          ) : null}
          <ConflictProvider value={problemMarks(problems)}>
            {result.file.body.length === 0 ? (
              <StartBody editor={editor} />
            ) : (
              <BlockTree nodes={result.file.body} onDescend={onDescend} editor={editor} socket={{ ownerId: null, flavor: "sequence" }} />
            )}
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

/**
 * The empty-body affordance (§ Adding … and the empty canvas): a start-a-body prompt plus the file
 * body's own open socket. Arm a kind in the palette and the socket appears; click it to seed the body.
 */
function StartBody({ editor }: { editor: EditorApi }): JSX.Element {
  return (
    <div className="start-body" role="region" aria-label="Start a body">
      <p className="start-body-hint">Empty body. Pick a step or block from the palette to start it.</p>
      {editor.socketOpen("sequence") ? (
        <button type="button" className="socket socket-tail" onClick={() => editor.placeIntoList(null)}>
          + add {editor.armedKind} here
        </button>
      ) : null}
    </div>
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

/**
 * The centred empty/loading affordance, reusing the tracer bullet's card. It deliberately carries no
 * `region`/`Workflow canvas` label — that landmark belongs to the *open* canvas, so a test (and a
 * screen reader) can wait for the real surface rather than matching this placeholder first.
 */
function CanvasNote({ title, hint, action }: { title: string; hint: string; action?: JSX.Element }): JSX.Element {
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
