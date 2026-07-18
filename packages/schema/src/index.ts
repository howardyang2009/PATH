// @path/schema — the single source of truth for workflow format v0.
// Normative reference: docs/format/workflow-format-v0.md; spec: docs/spec/mvp-spec.md §4.

export { FORMAT_VERSION } from "./workflow-file-type.js";
export type { WorkflowFile } from "./workflow-file-type.js";
export {
  WorkflowFileSchema,
  safeParseWorkflowFile,
  parseWorkflowFile,
  type WorkflowFileParseSuccess,
  type WorkflowFileParseFailure,
} from "./workflow-file.js";

export { NodeSchema, NodeArraySchema } from "./nodes.js";
export type {
  WorkflowNode,
  PromptStep,
  BinaryStep,
  WorkflowStep,
  ParallelNode,
  ParallelBranch,
  BranchNode,
  BranchArm,
  WhileDoNode,
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
} from "./condition-type.js";

export { WorkerSchema } from "./worker.js";
export type { Worker, EngineWorker, LlmWorker } from "./worker-type.js";

export { ConfigValueSchema, ConfigObjectSchema } from "./config.js";
export type { ConfigValue, ConfigObject, SecretWrapper } from "./config-value-type.js";

export type { JsonValue } from "./json-value.js";

export { IdSchema, NameSchema, NAME_PATTERN } from "./ids.js";

export {
  checkInterpolationSyntax,
  interpolableString,
  interpolatedJsonValue,
  type InterpolationRoot,
  type InterpolationCheckResult,
} from "./interpolation.js";
