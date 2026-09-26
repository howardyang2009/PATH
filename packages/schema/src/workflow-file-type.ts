import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { WorkflowNode } from "./node-type.js";

export const FORMAT_VERSION = "path/workflow@5";

// Superseded format strings, each mapped to the ordered codemod chain that lifts a file to the current
// format. A codemod migrates exactly one step and silently skips anything else, so the whole chain must
// be named; the engine reads the current format only and rejects an older string with a migration error.
export const SUPERSEDED_FORMAT_VERSIONS = {
  "path/workflow@0": [
    "scripts/archive/migrate-workflow-format-v1.ts",
    "scripts/archive/migrate-workflow-format-v2.ts",
    "scripts/archive/migrate-workflow-format-v3.ts",
    "scripts/archive/migrate-workflow-format-v4.ts",
    "scripts/migrate-workflow-format-v5.ts",
  ],
  "path/workflow@1": [
    "scripts/archive/migrate-workflow-format-v2.ts",
    "scripts/archive/migrate-workflow-format-v3.ts",
    "scripts/archive/migrate-workflow-format-v4.ts",
    "scripts/migrate-workflow-format-v5.ts",
  ],
  "path/workflow@2": [
    "scripts/archive/migrate-workflow-format-v3.ts",
    "scripts/archive/migrate-workflow-format-v4.ts",
    "scripts/migrate-workflow-format-v5.ts",
  ],
  "path/workflow@3": [
    "scripts/archive/migrate-workflow-format-v4.ts",
    "scripts/migrate-workflow-format-v5.ts",
  ],
  "path/workflow@4": ["scripts/migrate-workflow-format-v5.ts"],
} as const satisfies { [version: string]: readonly string[] };

export interface WorkflowFile {
  format: typeof FORMAT_VERSION;
  /** Durable machine identity — a UUIDv4, stable across saves (ADR 0006). */
  id: string;
  name: string;
  config?: ConfigObject;
  /** The file's default root-context seed when a launch gives no input override; plain JSON, root-run only. */
  input?: { [key: string]: JsonValue };
  body: WorkflowNode[];
  output?: { [key: string]: JsonValue };
  /** The file worker-default table (ADR 0044): `{ <stepType>: <workerName> }` for un-pinned steps, file-scoped. */
  worker_defaults?: { [stepType: string]: string };
}
