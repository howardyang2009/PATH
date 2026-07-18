import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { WorkflowNode } from "./node-type.js";
import type { Worker } from "./worker-type.js";

export const FORMAT_VERSION = "path/workflow@0";

export interface WorkflowFile {
  format: typeof FORMAT_VERSION;
  name: string;
  worker: Worker;
  config?: ConfigObject;
  body: WorkflowNode[];
  output?: { [key: string]: JsonValue };
}
