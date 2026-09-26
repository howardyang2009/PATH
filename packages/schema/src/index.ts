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
//
// This barrel is the convenience default. The package's `exports` map also names the seams a consumer
// can import narrowly, so an import says which module owns a name rather than "somewhere in schema":
// `@path/schema/nodes` (the registry-driven node factory), `@path/schema/node-walk` (the block
// grammar's one descent) and `@path/schema/wire-v0` (the v0 wire codec). Each is pinned by
// `test/subpath.test.ts`, since a package `exports` path is not something tsc alone checks.

export { FORMAT_VERSION } from "./workflow-file-type.js";
export type { WorkflowFile } from "./workflow-file-type.js";
export {
  makeBodySchema,
  makeWorkflowFileSchema,
  safeParseWorkflowFile,
  safeParseWorkflowFileWith,
  parseWorkflowFile,
  supersededFormatError,
  type WorkflowFileParseSuccess,
  type WorkflowFileParseFailure,
} from "./workflow-file.js";

// The Step-Template schema (ADR 0048): a strict `{ format, id, description, body }` envelope over the
// shared body validator, so a template's body is checked exactly as a file's body. Validity is
// per-node and registry-relative only — the file-scoped rules (name uniqueness, publish set,
// `worker_defaults`) are not run at template load, because a fragment cannot know the file it lands in.
export type { StepTemplate } from "./step-template-type.js";
export {
  makeStepTemplateSchema,
  safeParseStepTemplate,
  safeParseStepTemplateWith,
  parseStepTemplate,
  type StepTemplateParseSuccess,
  type StepTemplateParseFailure,
} from "./step-template.js";

// The publish set's two load-time rejections, as data (CONTEXT.md § Publish set): the load refinement
// and the Designer's canvas markers read the same walk, so a rule change cannot leave one silent.
export {
  publishKeysOf,
  publishSetIssues,
  type PublishSetIssue,
  type PublishSetIssueRule,
} from "./publish-set.js";

// The goto load refusals, as data (docs/spec/goto.md §2.3, ADR 0056): the load refinement reads them
// here, and the Designer's canvas marker reads the same walk.
export { gotoIssues, type GotoIssue, type GotoIssueRule } from "./goto.js";

// Node identity's one rule, as data (ADR 0006/0015): the load refinement's name check, the write
// route's duplicate-`id` check and the Designer's pre-parse open gate all read these, so the three
// doors cannot disagree about which occurrence offends, which one already held the value, and why.
export {
  identityIssues,
  nodeIdentityIssues,
  nodeIdentityOccurrences,
  workflowIdentityOccurrence,
  type IdentityOccurrence,
  type NodeIdentityIssue,
  type NodeIdentityRule,
} from "./node-identity.js";

// Instantiation (ADR 0049): the pure detached-copy transform that turns a Step-Template body into
// ordinary workflow nodes — a deep copy that re-stamps every id, keeps every other datum verbatim,
// uniquifies a colliding name, and wraps a 2+-node body for a single-node slot. Owned here beside the
// tree walks it uses (`childBodies`), so the Designer is a thin caller and the transform is unit-
// testable without a browser.
export { instantiate, instantiateWorkflow, type InstantiateOptions } from "./instantiate.js";

export {
  buildCoreMembers,
  ENVELOPE_KEYS,
  makeNodeSchema,
  RESERVED_TYPE_NAMES,
  type NodeRecursion,
  type RegistryStepType,
  type StepPluginRegistry,
} from "./nodes.js";

// The launch channel of ADR 0044's registry-relative `worker_defaults` validation (#518): the operator
// launch surfaces (CLI `--worker-default`, server `POST /v0/runs`) check their table here, at the
// launch boundary, and prefix their own source onto each returned message. The per-entry core
// (`collectWorkerDefaultIssues`) stays internal — the file channel imports it directly.
export { validateLaunchWorkerDefaults } from "./worker-defaults.js";

// The root-input fallback every launch door resolves the same way (format @4 §1a): a non-empty
// operator override, else the file's own top-level `input`, else `{}`. It sits here so `path run` and
// `POST /v0/runs` cannot disagree about which seed a run records.
export { effectiveRootInput } from "./effective-root-input.js";

// `outputSchema` validation (ADR 0040), shared by the two adapters that enforce it: the Complete route
// (which refuses the submit) and the browser's Complete form (which pre-checks the same output).
export { validateOutputSchema, type OutputValidation } from "./output-schema.js";
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
  GotoNode,
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
export {
  CONTROL_CHILD_SLOTS,
  childBodies,
  childNodePath,
  enclosingControlBlock,
  serialOrder,
  isStepType,
  mapChildBodies,
  walkNodes,
  type ChildSlot,
  type ControlBlockKind,
  type ControllerType,
  type NodeChildBody,
} from "./node-walk.js";

// Which roots are legal where — one declaration each, referenced rather than restated.
export {
  CONDITION_ROOTS,
  INTERPOLATION_ROOTS,
  PUBLISH_ROOTS,
  STEP_ROOTS,
  type ConditionRoot,
} from "./roots.js";

export type { BinaryWorkerName, PromptWorkerName } from "./worker-names.js";

export { ConfigValueSchema, ConfigObjectSchema } from "./config.js";
export type { ConfigValue, ConfigObject, EnvWrapper, SecretWrapper } from "./config-value-type.js";
export { isSecretWrapper, mapSecrets } from "./secret.js";
export { isEnvWrapper, mapEnv } from "./env.js";
export { updateAtConfigPath, valueAtConfigPath } from "./config-path.js";
export { isPlainObject } from "./wrapper.js";

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
export { blankRunRecord, RUN_RECORD_FIELDS, type RerunFromNodePathEntry, type RunRecord } from "./run-record.js";
export type { LaunchFacts } from "./launch-facts.js";
export { isIterationRun, isPassRun, isReuseRow, isRootRun, type RunKindFields } from "./run-kind.js";
export { childrenByParent, findRootRun, pathToRoot, subtree, type RunTreeFields } from "./run-tree.js";
export {
  boundaryLevels,
  classifyLevelK,
  selectBoundary,
  type BoundaryLevel,
  type BoundaryLevelRun,
  type BoundarySelection,
  type ClassifyLevelKArgs,
  type LegalKLevelReason,
  type LegalKLevelResult,
  type LegalKLevelRun,
} from "./legal-k.js";
export { rerunBoundaryIndex, rerunDisposition, type RerunDisposition } from "./rerun-disposition.js";
export { LOG_BACKEND_IDS, type LogBackendId } from "./log-backend-id.js";
export {
  ROOT_RUN_SUMMARY_FIELDS,
  fromWireLaunchFacts,
  fromWireRunRecord,
  toRootRunSummary,
  toWireLaunchFacts,
  toWireRunRecord,
  type BlobName,
  type CompleteRunRequest,
  type CompleteRunResponse,
  type GetTemplateResponse,
  type ListRunsResponse,
  type ListTemplatesResponse,
  type ListWorkflowsResponse,
  type RootRunSummary,
  type RunTreeResponse,
  type StartRunRequest,
  type StartRunResponse,
  type WireError,
  type WireLaunchFacts,
  type WireLeaseOpRequest,
  type WireLockHeldBody,
  type WireLockRequest,
  type WirePutWorkflowRequest,
  type WirePostTemplateRequest,
  type WirePutWorkflowResponse,
  type WireRunRecord,
  type WireTemplateWriteResponse,
  type TemplateSummary,
  type WireWorkflowLease,
  type WorkflowSummary,
} from "./wire-v0.js";
export {
  describeField,
  toWireStepPlugins,
  type StepPluginsResponse,
  type WireFieldSpec,
  type WireStepPlugin,
} from "./wire-step-plugins.js";
