import type { Condition } from "./condition-type.js";
import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { Worker } from "./worker-type.js";

interface CommonStepFields {
  id: string;
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
  id: string;
  body: WorkflowNode[];
}

export interface ParallelNode {
  type: "parallel";
  id: string;
  join: "collect";
  branches: ParallelBranch[];
}

export interface BranchArm {
  when: Condition;
  body: WorkflowNode[];
}

export interface BranchNode {
  type: "branch";
  id: string;
  arms: BranchArm[];
  else?: WorkflowNode[];
}

export interface WhileDoNode {
  type: "while-do";
  id: string;
  condition: Condition;
  max_iterations: number | string;
  body: WorkflowNode[];
}

export interface CheckpointNode {
  type: "checkpoint";
  id: string;
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
