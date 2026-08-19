import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { WorkflowNode } from "./node-type.js";
import type { Worker } from "./worker-type.js";

export const FORMAT_VERSION = "path/workflow@2";

// The superseded format strings. `@0` predates the GUID `id` + human `name` identity migration
// (ADR 0006/0007); `@1` predates the `@2` uniform single-node container migration (§0). The engine
// reads `@2` only — there is no dual reader — so a file carrying either is rejected at load with a
// targeted "run the codemod" message rather than a generic zod "invalid literal" on `format`
// (workflow-format-v2.md §1).
export const SUPERSEDED_FORMAT_VERSIONS = ["path/workflow@0", "path/workflow@1"] as const;

export interface WorkflowFile {
  format: typeof FORMAT_VERSION;
  /** Durable machine identity — a UUIDv4, the source-workflow identity #202 persists (ADR 0006). */
  id: string;
  name: string;
  worker: Worker;
  config?: ConfigObject;
  body: WorkflowNode[];
  output?: { [key: string]: JsonValue };
}
