/**
 * The canvas region: the centre surface where a `path/workflow@2` body is authored (§ Canvas
 * interaction model). Empty for the tracer bullet (#366) — no nodes, no open file yet. It shows the
 * empty-canvas affordance the spec names: the place a first node is dropped once dragging lands (§
 * Adding, reordering, deleting, and the empty canvas).
 */
export function Canvas() {
  return (
    <div className="canvas" role="region" aria-label="Workflow canvas">
      <div className="canvas-empty">
        <p className="canvas-empty-title">Empty canvas</p>
        <p className="canvas-empty-hint">
          No workflow open. A first node lands here once authoring is wired.
        </p>
      </div>
    </div>
  );
}
