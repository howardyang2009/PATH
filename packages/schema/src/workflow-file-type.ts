import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { WorkflowNode } from "./node-type.js";

export const FORMAT_VERSION = "path/workflow@3";

// The superseded format strings, each mapped to the codemod chain that lifts a file carrying it to
// the current format (`@3`). `@0` predates the GUID `id` + human `name` identity migration
// (ADR 0006/0007); `@1` predates the `@2` uniform single-node container migration (v2 §0); `@2`
// predates the worker-name migration (`worker` becomes a name string, `model`/`options` move to
// config — ADR 0021, workflow-format-v3.md §1). The engine reads `@3` only — there is no dual reader
// — so a file carrying an older string is rejected at load with a targeted "run the codemod" message
// rather than a generic zod "invalid literal" on `format`.
//
// Each entry names its codemod chain **in order**: a codemod migrates exactly one step and skips
// anything else silently (`LEGACY_FORMAT`), so an `@0` file must run v1 then v2 then v3, and naming
// only the last would send the author to a script that reports "skipped" and leaves the file exactly
// as unreadable as it was — a message naming a fix that is not one.
export const SUPERSEDED_FORMAT_VERSIONS = {
  "path/workflow@0": [
    "scripts/migrate-workflow-format-v1.ts",
    "scripts/migrate-workflow-format-v2.ts",
    "scripts/migrate-workflow-format-v3.ts",
  ],
  "path/workflow@1": ["scripts/migrate-workflow-format-v2.ts", "scripts/migrate-workflow-format-v3.ts"],
  "path/workflow@2": ["scripts/migrate-workflow-format-v3.ts"],
} as const satisfies { [version: string]: readonly string[] };

// A `@3` file carries no file-level `worker` (ADR 0021 sub-8): a worker is a per-step name now, and
// `model`/`options` travel through config. The former `worker: Worker` field is gone.
export interface WorkflowFile {
  format: typeof FORMAT_VERSION;
  /** Durable machine identity — a UUIDv4, the source-workflow identity #202 persists (ADR 0006). */
  id: string;
  name: string;
  config?: ConfigObject;
  body: WorkflowNode[];
  output?: { [key: string]: JsonValue };
}
