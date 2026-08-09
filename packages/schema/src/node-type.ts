import type { Condition } from "./condition-type.js";
import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { Worker } from "./worker-type.js";

interface CommonStepFields {
  /** Durable machine identity — a UUIDv4, the reuse/resume key and audit `node_id` (ADR 0006). */
  id: string;
  /** Human label, unique across the whole file — keys output objects and the log narration. */
  name: string;
  worker?: Worker;
  config?: ConfigObject;
  input?: JsonValue;
  parse?: "text" | "json";
  publish?: { [key: string]: JsonValue };
}

export interface PromptStep extends CommonStepFields {
  type: "prompt";
  prompt: string;
}

export interface BinaryStep extends CommonStepFields {
  type: "binary";
  command: string;
  args?: string[];
  cwd?: string;
}

export interface WorkflowStep extends CommonStepFields {
  type: "workflow";
  ref: string;
}

export interface ParallelBranch {
  /** Durable machine identity — a UUIDv4 (ADR 0006). */
  id: string;
  /** Human label, unique across the whole file — keys `collect`/`wait-one` output. */
  name: string;
  body: WorkflowNode[];
}

export interface ParallelNode {
  type: "parallel";
  id: string;
  name: string;
  join: "collect" | "wait-one";
  branches: ParallelBranch[];
}

export interface BranchArm {
  when: Condition;
  body: WorkflowNode[];
}

export interface BranchNode {
  type: "branch";
  id: string;
  name: string;
  arms: BranchArm[];
  else?: WorkflowNode[];
}

export interface WhileDoNode {
  type: "while-do";
  id: string;
  name: string;
  condition: Condition;
  max_iterations: number | string;
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
  | CheckpointNode;
