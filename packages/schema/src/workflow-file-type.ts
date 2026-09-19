import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { WorkflowNode } from "./node-type.js";

export const FORMAT_VERSION = "path/workflow@4";

// The superseded format strings, each mapped to the codemod chain that lifts a file carrying it to
// the current format (`@4`). `@0` predates the GUID `id` + human `name` identity migration
// (ADR 0006/0007); `@1` predates the `@2` uniform single-node container migration (v2 §0); `@2`
// predates the worker-name migration (`worker` becomes a name string, `model`/`options` move to
// config — ADR 0021, workflow-format-v3.md §1); `@3` predates the file-level `worker_defaults`
// envelope grammar (ADR 0044, workflow-format-v4.md), which the `@4` codemod is a no-op stamp for.
// The engine reads `@4` only — there is no dual reader — so a file carrying an older string is
// rejected at load with a targeted "run the codemod" message rather than a generic zod "invalid
// literal" on `format`.
//
// Each entry names its codemod chain **in order**: a codemod migrates exactly one step and skips
// anything else silently (`LEGACY_FORMAT`), so an `@0` file must run v1 then v2 then v3 then v4, and
// naming only the last would send the author to a script that reports "skipped" and leaves the file
// exactly as unreadable as it was — a message naming a fix that is not one.
export const SUPERSEDED_FORMAT_VERSIONS = {
  "path/workflow@0": [
    "scripts/migrate-workflow-format-v1.ts",
    "scripts/migrate-workflow-format-v2.ts",
    "scripts/migrate-workflow-format-v3.ts",
    "scripts/migrate-workflow-format-v4.ts",
  ],
  "path/workflow@1": [
    "scripts/migrate-workflow-format-v2.ts",
    "scripts/migrate-workflow-format-v3.ts",
    "scripts/migrate-workflow-format-v4.ts",
  ],
  "path/workflow@2": ["scripts/migrate-workflow-format-v3.ts", "scripts/migrate-workflow-format-v4.ts"],
  "path/workflow@3": ["scripts/migrate-workflow-format-v4.ts"],
} as const satisfies { [version: string]: readonly string[] };

// A `@4` file carries no file-level `worker` (ADR 0021 sub-8): a worker is a per-step name now, and
// `model`/`options` travel through config. The former `worker: Worker` field is gone. `@4` adds the
// file-level `worker_defaults` table over `@3` (ADR 0044) — an envelope grammar change, hence the bump.
export interface WorkflowFile {
  format: typeof FORMAT_VERSION;
  /** Durable machine identity — a UUIDv4, the source-workflow identity #202 persists (ADR 0006). */
  id: string;
  name: string;
  config?: ConfigObject;
  body: WorkflowNode[];
  output?: { [key: string]: JsonValue };
  /**
   * The **file worker-default** table (ADR 0044): a `{ <stepType>: <workerName> }` map picking which
   * worker a type's *un-pinned* steps use in this file. File-scoped — it never crosses a `workflow`-ref
   * boundary. A *selection* by name, not config inheritance (CONTEXT.md invariant 5). Registry-relative
   * validity (a real type shipping that worker) is checked at engine load, not by this shape.
   */
  worker_defaults?: { [stepType: string]: string };
}
