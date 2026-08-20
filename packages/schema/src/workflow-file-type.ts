import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { WorkflowNode } from "./node-type.js";
import type { Worker } from "./worker-type.js";

export const FORMAT_VERSION = "path/workflow@2";

// The superseded format strings, each mapped to the codemod chain that lifts a file carrying it to
// `@2`. `@0` predates the GUID `id` + human `name` identity migration (ADR 0006/0007); `@1` predates
// the `@2` uniform single-node container migration (§0). The engine reads `@2` only — there is no
// dual reader — so a file carrying either is rejected at load with a targeted "run the codemod"
// message rather than a generic zod "invalid literal" on `format` (workflow-format-v2.md §1).
//
// `@0` names two scripts, in order, because the `@2` codemod migrates `@1` and nothing else — it
// skips a `@0` file *silently* (`migrate-workflow-format-v2.ts`, `LEGACY_FORMAT`). Naming only the
// `@2` script to an `@0` author would send them to a script that reports "skipped" and leaves the
// file exactly as unreadable as it was, so the message would name a fix that is not one.
export const SUPERSEDED_FORMAT_VERSIONS = {
  "path/workflow@0": ["scripts/migrate-workflow-format-v1.ts", "scripts/migrate-workflow-format-v2.ts"],
  "path/workflow@1": ["scripts/migrate-workflow-format-v2.ts"],
} as const satisfies { [version: string]: readonly string[] };

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
