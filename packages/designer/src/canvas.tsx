import { BlockTree } from "./block-tree.js";
import { basename } from "./resolve-ref.js";
import type { Frame, OpenSession } from "./use-open-file.js";

/**
 * The canvas region: the centre surface a `path/workflow` body renders read-only on (#367, designer-spec
 * § Canvas interaction model). It shows one of four things: the empty affordance when nothing is open,
 * a registry/fetch problem, a legible **refusal** (an unregistered step type, or a duplicate/invalid id
 * — ADR 0026 / ADR 0015), or the block-grammar render of the open file under a file breadcrumb that
 * tracks each `workflow`-ref crossing. No editing yet — structure and read-only summaries only.
 */
export function Canvas({ session }: { session: OpenSession }): JSX.Element {
  const { registry, frames, descend, goTo } = session;

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
        hint="No workflow open. Open one with ?path=<relative/path.workflow.json>."
      />
    );
  }

  const active = frames[frames.length - 1]!;
  return (
    <div className="canvas" role="region" aria-label="Workflow canvas">
      <Breadcrumb frames={frames} onCrumb={goTo} />
      <div className="canvas-body">
        <FrameView frame={active} onDescend={descend} />
      </div>
    </div>
  );
}

/** The file breadcrumb: one crumb per navigation-stack frame, the last (current) one inert. */
function Breadcrumb({ frames, onCrumb }: { frames: Frame[]; onCrumb: (index: number) => void }): JSX.Element {
  return (
    <nav className="breadcrumb" aria-label="File breadcrumb">
      {frames.map((frame, index) => {
        const last = index === frames.length - 1;
        const label = frameLabel(frame);
        return (
          <span className="crumb-wrap" key={`${index}:${frame.path}`}>
            {index > 0 ? <span className="crumb-sep" aria-hidden="true">/</span> : null}
            {last ? (
              <span className="crumb crumb-current" aria-current="page" title={frame.path}>
                {label}
              </span>
            ) : (
              <button type="button" className="crumb" title={frame.path} onClick={() => onCrumb(index)}>
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
  return basename(frame.path);
}

/** Render one frame: loading, a fetch error, a refusal, or the opened block tree. */
function FrameView({ frame, onDescend }: { frame: Frame; onDescend: (ref: string) => void }): JSX.Element {
  const { state } = frame;
  if (state.phase === "loading") {
    return <p className="pane-note">Loading {frame.path}…</p>;
  }
  if (state.phase === "fetch-error") {
    return <Refusal heading="Could not read the file" message={state.message} />;
  }

  const { result } = state;
  switch (result.status) {
    case "opened":
      return (
        <div className="opened" data-dirty={result.dirty ? "true" : "false"}>
          {result.dirty ? (
            <p className="dirty-badge" role="status">
              Ids stamped on import — unsaved (ADR 0015).
            </p>
          ) : null}
          <BlockTree nodes={result.file.body} onDescend={onDescend} />
        </div>
      );
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
function CanvasNote({ title, hint }: { title: string; hint: string }): JSX.Element {
  return (
    <div className="canvas">
      <div className="canvas-empty">
        <p className="canvas-empty-title">{title}</p>
        <p className="canvas-empty-hint">{hint}</p>
      </div>
    </div>
  );
}
