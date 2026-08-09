import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { WorkflowNode } from "./node-type.js";
import type { Worker } from "./worker-type.js";

export const FORMAT_VERSION = "path/workflow@1";

// The pre-identity format string. A file still carrying it predates the GUID `id` + human `name`
// migration (ADR 0006/0007); the loader rejects it with a targeted "run the codemod" message rather
// than a generic zod "invalid literal" on `format`.
export const LEGACY_FORMAT_VERSION = "path/workflow@0";

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
