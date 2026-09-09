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

// The shared run-action forms and their helpers: the Designer's run dock mounts the very same pieces,
// so a launch/resume reads identically on both surfaces (ADR 0031). `ResumeActions` (the two resume
// verbs over one shared config field) rides inside `RunsList`, so consumers get it by passing a tree.
export { LaunchForm, type LaunchFormProps } from "./launch-form.js";
export { ResumeActions, type ResumeActionsProps } from "./resume-actions.js";
export { JsonField } from "./json-field.js";
export { errorMessage, type Load } from "./load-state.js";
