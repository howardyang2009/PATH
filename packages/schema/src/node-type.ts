import type { Condition } from "./condition-type.js";
import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { BinaryWorkerName, PromptWorkerName } from "./worker-names.js";

interface CommonStepFields {
  /** Durable machine identity — a UUIDv4, the reuse/resume key and audit `node_id` (ADR 0006). */
  id: string;
  /** Human label, unique across the whole file — keys output objects and the log narration. */
  name: string;
  config?: ConfigObject;
  input?: JsonValue;
  parse?: "text" | "json";
  publish?: { [key: string]: JsonValue };
}

export interface PromptStep extends CommonStepFields {
  type: "prompt";
  /** The worker *name* to run on (`@3` §4); omitted resolves to `prompt`'s default worker `sdk`. */
  worker?: PromptWorkerName;
  prompt: string;
}

export interface BinaryStep extends CommonStepFields {
  type: "binary";
  /** The worker *name* to run on (`@3` §4); omitted resolves to `binary`'s default worker `spawn`. */
  worker?: BinaryWorkerName;
  command: string;
  args?: string[];
  cwd?: string;
}

// A `workflow` step runs a nested workflow-run, not a worker (`@3` §4) — so it carries no `worker`.
export interface WorkflowStep extends CommonStepFields {
  type: "workflow";
  ref: string;
}

export interface ParallelNode {
  type: "parallel";
  id: string;
  name: string;
  join: "collect" | "wait-one" | "do-not-wait";
  /** Each branch is a node carrying its own `id` + `name` — the `collect`/`wait-one` output key (`@2` §4.3). */
  branches: WorkflowNode[];
}

export interface BranchArm {
  when: Condition;
  /** The arm's occupant is a single node (`@2` §4.3) — a `sequence` where several nodes are needed. */
  node: WorkflowNode;
}

export interface BranchNode {
  type: "branch";
  id: string;
  name: string;
  arms: BranchArm[];
  /** The `else` occupant is a single node (`@2` §4.3). */
  else?: WorkflowNode;
}

export interface WhileDoNode {
  type: "while-do";
  id: string;
  name: string;
  condition: Condition;
  max_iterations: number | string;
  /** The loop body is a single node (`@2` §4.3). */
  node: WorkflowNode;
}

export interface SequenceNode {
  type: "sequence";
  id: string;
  name: string;
  /** Node array, minimum length 1 — the nodes run in order; output is the last child's (`@2` §4.4). */
  body: WorkflowNode[];
}

export interface CheckpointNode {
  type: "checkpoint";
  id: string;
  name: string;
  condition: Condition;
}

export type WorkflowNode =
  | PromptStep
  | BinaryStep
  | WorkflowStep
  | ParallelNode
  | BranchNode
  | WhileDoNode
  | SequenceNode
  | CheckpointNode;
