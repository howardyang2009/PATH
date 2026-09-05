// @path/schema — the single source of truth for the PATH domain: what an author writes, and the
// vocabulary its execution produces.
//
//   Workflow format v0 — steps, workers, control blocks, conditions, config, interpolation.
//     Normative reference: docs/format/workflow-format-v0.md; spec: docs/spec/mvp-spec.md §4.
//   Runtime vocabulary — run status, the log-event stream, condition traces, the run record, and
//     the v0 wire shapes that carry them. Normative reference: docs/api/server-api-v0.md.
//
// The runtime half lives here rather than in @path/engine because a *reader* of a run needs it
// without needing an engine to read one: `@path/client-core` runs in a browser and would otherwise
// depend on a package carrying SQLite, child processes and the Agent SDK for two type-only names.
// The line is what a run *is* (here) versus how a run is *stored* or *executed* (@path/engine).

export { FORMAT_VERSION } from "./workflow-file-type.js";
export type { WorkflowFile } from "./workflow-file-type.js";
export {
  makeWorkflowFileSchema,
  safeParseWorkflowFile,
  safeParseWorkflowFileWith,
  parseWorkflowFile,
  type WorkflowFileParseSuccess,
  type WorkflowFileParseFailure,
} from "./workflow-file.js";

export {
  buildCoreMembers,
  ENVELOPE_KEYS,
  makeNodeSchema,
  RESERVED_TYPE_NAMES,
  type NodeRecursion,
  type RegistryStepType,
  type StepPluginRegistry,
} from "./nodes.js";
export type {
  WorkflowNode,
  PromptStep,
  BinaryStep,
  WorkflowStep,
  ParallelNode,
  BranchNode,
  BranchArm,
  WhileDoNode,
  SequenceNode,
  CheckpointNode,
} from "./node-type.js";

export { ConditionSchema } from "./conditions.js";
export type {
  Condition,
  ExistsCondition,
  EqualsCondition,
  OneOfCondition,
  MatchesCondition,
  RangeCondition,
  ValidJsonCondition,
  AllCondition,
  AnyCondition,
  NotCondition,
  JsonScalar,
  LeafCondition,
  LeafConditionType,
} from "./condition-type.js";
export { LEAF_CONDITION_TYPES } from "./condition-type.js";

// The dot-path grammar (format §5, §9) — one declaration, and both operations over it: the
// load-time syntax check and the runtime walk.
export { checkDotPath, resolveDotPath, type DotPathCheckResult, type DotPathResolution } from "./dot-path.js";

// The block grammar's descent (format §3) — stated once, so a node type added to the format cannot
// be silently skipped by anything that walks a workflow body.
export { CONTROL_CHILD_SLOTS, childBodies, mapChildBodies, walkNodes, type ChildSlot, type NodeChildBody } from "./node-walk.js";

// Which roots are legal where — one declaration each, referenced rather than restated.
export {
  CONDITION_ROOTS,
  INTERPOLATION_ROOTS,
  PUBLISH_ROOTS,
  STEP_ROOTS,
  type ConditionRoot,
} from "./roots.js";

export {
  BINARY_WORKER_NAMES,
  BINARY_DEFAULT_WORKER,
  PROMPT_WORKER_NAMES,
  PROMPT_DEFAULT_WORKER,
  type BinaryWorkerName,
  type PromptWorkerName,
} from "./worker-names.js";

export { ConfigValueSchema, ConfigObjectSchema } from "./config.js";
export type { ConfigValue, ConfigObject, EnvWrapper, SecretWrapper } from "./config-value-type.js";
export { isSecretWrapper, mapSecrets } from "./secret.js";
export { isEnvWrapper, mapEnv } from "./env.js";

export type { JsonValue } from "./json-value.js";

export { IdSchema, NameSchema, NAME_PATTERN } from "./ids.js";

export {
  checkInterpolationSyntax,
  interpolableString,
  interpolatedJsonValue,
  tokenizeInterpolation,
  type InterpolationCheckResult,
  type InterpolationRoot,
  type InterpolationToken,
} from "./interpolation.js";
export { formatIssues } from "./format-issues.js";

// ── Runtime vocabulary ────────────────────────────────────────────────────────────────────────
export {
  isTerminal,
  RUN_STATUSES,
  RunStatusSchema,
  TERMINAL_RUN_STATUSES,
  TerminalRunStatusSchema,
  type RunStatus,
  type TerminalRunStatus,
} from "./run-status.js";
export type { AllTrace, AnyTrace, ConditionOutcome, LeafTrace, NotTrace, Trace } from "./trace.js";
export { TraceSchema } from "./trace.js";
export {
  LogEventSchema,
  type JoinAppliedEvent,
  type LogEvent,
  type ReuseMarkerEvent,
  type RunCancelledEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
} from "./log-event.js";
export {
  createEventFrameDecoder,
  encodeEventFrame,
  eventStreamHeaders,
  type EventFrame,
  type EventFrameDecoder,
} from "./event-frame.js";
export type { RunRecord } from "./run-record.js";
export { isReuseRow, isRootRun, runKind, type RunKind, type RunKindFields } from "./run-kind.js";
export { childrenByParent, findRootRun, subtree, type RunTreeFields } from "./run-tree.js";
export { LOG_BACKEND_IDS, type LogBackendId } from "./log-backend-id.js";
export {
  toRootRunSummary,
  toWireRunRecord,
  type BlobName,
  type ListRunsResponse,
  type ListWorkflowsResponse,
  type RootRunSummary,
  type RunTreeResponse,
  type StartRunRequest,
  type StartRunResponse,
  type WireError,
  type WireRunRecord,
  type WorkflowSummary,
} from "./wire-v0.js";
export {
  describeField,
  toWireStepPlugins,
  type StepPluginsResponse,
  type WireFieldSpec,
  type WireStepPlugin,
} from "./wire-step-plugins.js";
