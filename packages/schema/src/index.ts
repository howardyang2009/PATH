// @path/schema — the single source of truth for the PATH domain: what an author writes, and the
// vocabulary its execution produces.
//
//   Workflow format v0 — steps, workers, control blocks, conditions, config, interpolation.
//     Normative reference: docs/format/docs/format/workflow-format.md; spec: docs/spec/mvp-spec.md §4.
//   Runtime vocabulary — run status, the log-event stream, condition traces, the run record, and
//     the v0 wire shapes that carry them. Normative reference: docs/api/server-api-v0.md.
//
// The runtime half lives here rather than in @path/engine because a *reader* of a run needs it
// without needing an engine to read one: `@path/client-core` runs in a browser and would otherwise
// depend on a package carrying SQLite, child processes and the Agent SDK for two type-only names.
// The line is what a run *is* (here) versus how a run is *stored* or *executed* (@path/engine).
//
// This barrel is the convenience default. The package's `exports` map also names the seams a consumer
// can import narrowly, so an import says which module owns a name rather than "somewhere in schema":
// `@path/schema/nodes` (the registry-driven node factory), `@path/schema/node-walk` (the block
// grammar's one descent) and `@path/schema/wire-v0` (the v0 wire codec). Each is pinned by
// `test/subpath.test.ts`, since a package `exports` path is not something tsc alone checks.

export type {
  AllCondition,
  AnyCondition,
  Condition,
  EqualsCondition,
  ExistsCondition,
  JsonScalar,
  LeafCondition,
  LeafConditionType,
  MatchesCondition,
  NotCondition,
  OneOfCondition,
  RangeCondition,
  ValidJsonCondition,
} from "./condition-type.js";
export { LEAF_CONDITION_TYPES } from "./condition-type.js";
export { ConditionSchema } from "./conditions.js";
export { ConfigObjectSchema, ConfigValueSchema } from "./config.js";
export { updateAtConfigPath, valueAtConfigPath } from "./config-path.js";
export type { ConfigObject, ConfigValue, EnvWrapper, SecretWrapper } from "./config-value-type.js";
// The dot-path grammar (format §6, §9) — one declaration, and both operations over it: the
// load-time syntax check and the runtime walk.
export {
  checkDotPath,
  type DotPathCheckResult,
  type DotPathResolution,
  resolveDotPath,
} from "./dot-path.js";
// The root-input fallback every launch door resolves the same way (format @4 §1a): a non-empty
// operator override, else the file's own top-level `input`, else `{}`. It sits here so `path run` and
// `POST /v0/runs` cannot disagree about which seed a run records.
export { effectiveRootInput, launchInput } from "./effective-root-input.js";
export { isEnvWrapper, mapEnv } from "./env.js";
export {
  createEventFrameDecoder,
  type EventFrame,
  type EventFrameDecoder,
  encodeEventFrame,
  eventStreamHeaders,
} from "./event-frame.js";
export { formatIssues } from "./format-issues.js";
// The goto load refusals, as data (docs/spec/goto.md §2.3, ADR 0056): the load refinement reads them
// here, and the Designer's canvas marker reads the same walk.
export { type GotoIssue, type GotoIssueRule, gotoIssues } from "./goto.js";
export { IdSchema, NAME_PATTERN, NameSchema } from "./ids.js";
// Instantiation (ADR 0049): the pure detached-copy transform that turns a Step-Template body into
// ordinary workflow nodes — re-stamps every id, keeps other data verbatim, wraps a 2+-node body for a
// single-node slot. Owned here beside the tree walk it uses, so the Designer is a thin caller.
export {
  type InstantiateOptions,
  instantiate,
  instantiateWorkflow,
  uniqueName,
} from "./instantiate.js";
export {
  checkInterpolationSyntax,
  type InterpolationCheckResult,
  type InterpolationRoot,
  type InterpolationToken,
  interpolableString,
  interpolatedJsonValue,
  tokenizeInterpolation,
} from "./interpolation.js";
export type { JsonValue } from "./json-value.js";
export type { LaunchFacts } from "./launch-facts.js";
export {
  type BoundaryLevel,
  type BoundaryLevelRun,
  type BoundarySelection,
  boundaryLevels,
  type ClassifyLevelKArgs,
  classifyLevelK,
  type LegalKLevelReason,
  type LegalKLevelResult,
  type LegalKLevelRun,
  selectBoundary,
} from "./legal-k.js";
export { LOG_BACKEND_IDS, type LogBackendId } from "./log-backend-id.js";
export {
  type JoinAppliedEvent,
  type LogEvent,
  LogEventSchema,
  type ReuseMarkerEvent,
  type RunCancelledEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
} from "./log-event.js";
// Node identity's one rule, as data (ADR 0006/0015): the load refinement's name check, the write
// route's duplicate-`id` check and the Designer's pre-parse open gate all read these, so the three
// doors cannot disagree about which occurrence offends, which one already held the value, and why.
export {
  type IdentityOccurrence,
  identityIssues,
  type NodeIdentityIssue,
  type NodeIdentityRule,
  nodeIdentityIssues,
  nodeIdentityOccurrences,
  workflowIdentityOccurrence,
} from "./node-identity.js";
export type {
  BinaryStep,
  BranchArm,
  BranchNode,
  CheckpointNode,
  GotoNode,
  ParallelNode,
  PromptStep,
  SequenceNode,
  WhileDoNode,
  WorkflowNode,
  WorkflowStep,
} from "./node-type.js";
// The block grammar's descent (format §3) — stated once, so a node type added to the format cannot
// be silently skipped by anything that walks a workflow body.
export {
  type ChildSlot,
  CONTROL_CHILD_SLOTS,
  type ControlBlockKind,
  type ControllerType,
  childBodies,
  childNodePath,
  enclosingControlBlock,
  isStepType,
  mapChildBodies,
  type NodeChildBody,
  serialOrder,
  walkNodes,
} from "./node-walk.js";
export {
  buildCoreMembers,
  ENVELOPE_KEYS,
  makeNodeSchema,
  type NodeRecursion,
  RESERVED_TYPE_NAMES,
  type RegistryStepType,
  type StepPluginRegistry,
} from "./nodes.js";
// `outputSchema` validation (ADR 0040), shared by the two adapters that enforce it: the Complete route
// (which refuses the submit) and the browser's Complete form (which pre-checks the same output).
export { type OutputValidation, validateOutputSchema } from "./output-schema.js";
// The publish set's two load-time rejections, as data (CONTEXT.md § Publish set): the load refinement
// and the Designer's canvas markers read the same walk, so a rule change cannot leave one silent.
export {
  type PublishSetIssue,
  type PublishSetIssueRule,
  publishKeysOf,
  publishSetIssues,
} from "./publish-set.js";
export {
  type RerunDisposition,
  rerunBoundaryIndex,
  rerunDisposition,
} from "./rerun-disposition.js";
// Which roots are legal where — one declaration each, referenced rather than restated.
export {
  CONDITION_ROOTS,
  type ConditionRoot,
  INTERPOLATION_ROOTS,
  PUBLISH_ROOTS,
  STEP_ROOTS,
} from "./roots.js";
export {
  isIterationRun,
  isPassRun,
  isReuseRow,
  isRootRun,
  type RunKindFields,
} from "./run-kind.js";
export {
  blankRunRecord,
  type RerunFromNodePathEntry,
  RUN_RECORD_FIELDS,
  type RunRecord,
} from "./run-record.js";
// ── Runtime vocabulary ────────────────────────────────────────────────────────────────────────
export {
  isTerminal,
  RUN_STATUSES,
  type RunStatus,
  RunStatusSchema,
  TERMINAL_RUN_STATUSES,
  type TerminalRunStatus,
  TerminalRunStatusSchema,
} from "./run-status.js";
export {
  childrenByParent,
  findRootRun,
  pathToRoot,
  type RunTreeFields,
  subtree,
} from "./run-tree.js";
export { isSecretWrapper, mapSecrets } from "./secret.js";
export {
  makeStepTemplateSchema,
  parseStepTemplate,
  type StepTemplateParseFailure,
  type StepTemplateParseSuccess,
  safeParseStepTemplate,
  safeParseStepTemplateWith,
} from "./step-template.js";
// The Step-Template schema (ADR 0048): a strict `{ format, id, description, body }` envelope over the
// shared body validator. File-scoped rules are not run at template load — a fragment cannot know the
// file it lands in.
export type { StepTemplate } from "./step-template-type.js";
export type { AllTrace, AnyTrace, ConditionOutcome, LeafTrace, NotTrace, Trace } from "./trace.js";
export { TraceSchema } from "./trace.js";
export {
  describeField,
  type StepPluginsResponse,
  toWireStepPlugins,
  type WireFieldSpec,
  type WireStepPlugin,
} from "./wire-step-plugins.js";
export {
  type BlobName,
  type CompleteRunRequest,
  type CompleteRunResponse,
  fromWireLaunchFacts,
  fromWireRunRecord,
  type GetTemplateResponse,
  type ListRunsResponse,
  type ListTemplatesResponse,
  type ListWorkflowsResponse,
  ROOT_RUN_SUMMARY_FIELDS,
  type RootRunSummary,
  type RunTreeResponse,
  type StartRunRequest,
  type StartRunResponse,
  type TemplateSummary,
  toRootRunSummary,
  toWireLaunchFacts,
  toWireRunRecord,
  type WireError,
  type WireLaunchFacts,
  type WireLeaseOpRequest,
  type WireLockHeldBody,
  type WireLockRequest,
  type WirePostTemplateRequest,
  type WirePutWorkflowRequest,
  type WirePutWorkflowResponse,
  type WireRunRecord,
  type WireTemplateWriteResponse,
  type WireWorkflowLease,
  type WorkflowSummary,
} from "./wire-v0.js";
// The launch channel of ADR 0044's registry-relative `worker_defaults` validation: the operator launch
// surfaces check their table here, at the launch boundary, and prefix their own source onto each message.
export { validateLaunchWorkerDefaults } from "./worker-defaults.js";
export type { BinaryWorkerName, PromptWorkerName } from "./worker-names.js";
export {
  makeBodySchema,
  makeWorkflowFileSchema,
  parseWorkflowFile,
  safeParseWorkflowFile,
  safeParseWorkflowFileWith,
  supersededFormatError,
  type WorkflowFileParseFailure,
  type WorkflowFileParseSuccess,
} from "./workflow-file.js";
export type { WorkflowFile } from "./workflow-file-type.js";
export { FORMAT_VERSION } from "./workflow-file-type.js";
export { isPlainObject } from "./wrapper.js";
