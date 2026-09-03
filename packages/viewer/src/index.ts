// @path/viewer — the run-monitoring surface. Its App is the standalone viewer, but the three read
// panels below are the reusable half: the Designer's run dock mounts the very same components so the
// two surfaces watch a run identically (they already share the framework-free seam in
// `@path/client-core`; this barrel shares the React panels on top of it). The panels are scope- and
// affordance-parametrised — the Viewer runs them cross-workflow, the Designer scopes them to the file
// it has open — so reuse never means a fork drifting out of step.
//
// Consumers must also import the panels' stylesheet: `@path/viewer/viewer.css` (and `tokens.css`).
export { RunsList, RUNS_REFRESH_MS, type RunsListProps } from "./runs-list.js";
export { RunDetail, type RunDetailProps } from "./run-detail.js";
export { NodeIo, type NodeIoProps } from "./node-io.js";
export { useRunView, type RunViewLoad } from "./use-run-view.js";
