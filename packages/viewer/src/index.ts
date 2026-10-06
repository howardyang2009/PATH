// @path/viewer — its App is the standalone viewer; the Designer's run dock mounts the same panels.
// Consumers must also import `@path/viewer/viewer.css`.

// Sign-in: the gate both apps render inside, and the user menu each header carries.
export { AuthGate, type AuthGateProps, UserMenu } from "./auth-gate.js";
export {
  beginDrag,
  type DragSize,
  type DragSizeHandleProps,
  type DragSizeOptions,
  type DragTransport,
  useDragSize,
} from "./drag-size.js";
export { JsonField } from "./json-field.js";
export { LaunchForm, type LaunchFormProps } from "./launch-form.js";
export { errorMessage, type Load } from "./load-state.js";
export { mountApp } from "./mount-app.js";
export { NodeIo, type NodeIoProps } from "./node-io.js";
export {
  ResumeActions,
  type ResumeActionsProps,
  type ResumeFromAffordance,
} from "./resume-actions.js";
export { RunDetail, type RunDetailProps } from "./run-detail.js";
export { RUNS_REFRESH_MS, RunsList, type RunsListProps } from "./runs-list.js";
export {
  type PaneHandleProps,
  type PaneWidths,
  type PaneWidthsOptions,
  usePaneWidths,
} from "./use-pane-resize.js";
export { type RunViewLoad, useRunView } from "./use-run-view.js";
// The one worker-default editor, shared by the Designer's file region and the launch form.
export {
  WorkerDefaultsEditor,
  type WorkerDefaultsEditorProps,
  workerDefaultCandidates,
} from "./worker-defaults.js";
