import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { WorkflowNode } from "./node-type.js";

export const FORMAT_VERSION = "path/workflow@5";

// The superseded format strings, each mapped to the codemod chain that lifts a file carrying it to
// the current format (`@5`). `@0` predates the GUID `id` + human `name` identity migration
// (ADR 0006/0007); `@1` predates the `@2` uniform single-node container migration (v2 §0); `@2`
// predates the worker-name migration (`worker` becomes a name string, `model`/`options` move to
// config — ADR 0021, workflow-format-v3.md §1); `@3` predates the file-level `worker_defaults`
// envelope grammar (ADR 0044, workflow-format-v4.md), which the `@4` codemod is a no-op stamp for;
// `@4` predates the `goto` controller (ADR 0058, workflow-format-v5.md), which the `@5` codemod is
// likewise a no-op stamp for. The engine reads `@5` only — there is no dual reader — so a file
// carrying an older string is rejected at load with a targeted "run the codemod" message rather than
// a generic zod "invalid literal" on `format`.
//
// Each entry names its codemod chain **in order**: a codemod migrates exactly one step and skips
// anything else silently (`LEGACY_FORMAT`), so an `@0` file must run v1 through v5 in order, and
// naming only the last would send the author to a script that reports "skipped" and leaves the file
// exactly as unreadable as it was — a message naming a fix that is not one. Only the current step,
// v5, sits at the top of `scripts/`; v1–v4 live in `scripts/archive/` because no file written today
// starts from the formats they lift, but they stay runnable for one still carrying those strings.
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

// A `@5` file carries no file-level `worker` (ADR 0021 sub-8): a worker is a per-step name now, and
// `model`/`options` travel through config. The former `worker: Worker` field is gone. `@4` adds the
// file-level `worker_defaults` table over `@3` (ADR 0044) — an envelope grammar change, hence the bump.
// A file also carries the optional file-level `input` seed (added under `@4`). It is additive and
// optional, so a file written before it existed stays valid and the format string did not move for it.
// `@5` is the format the `goto` controller lands in (ADR 0058); it changes nothing in the envelope.
export interface WorkflowFile {
  format: typeof FORMAT_VERSION;
  /** Durable machine identity — a UUIDv4, the source-workflow identity #202 persists (ADR 0006). */
  id: string;
  name: string;
  config?: ConfigObject;
  /**
   * The file's own **input** object: the default root context seed a launch sends when the operator
   * supplies no launch-time input override. Plain JSON data — the same shape a launch's `input` field
   * carries (`RunOptions.input`), with no `$secret`/`$env` wrappers and no `${…}` interpolation,
   * because nothing resolves it before it seeds context. It seeds the root run only; it never crosses
   * into a nested `workflow`-ref file, whose context comes from the parent step's input.
   */
  input?: { [key: string]: JsonValue };
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
