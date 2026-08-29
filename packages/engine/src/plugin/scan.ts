import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RESERVED_TYPE_NAMES } from "@path/schema";

import type { StepPlugin } from "./seam.js";

/**
 * The engine-side plugin discovery scanner (ADR 0019 sub-decisions 7–17, #335). It turns the one fixed
 * plugin directory into a frozen registry: it reads the directory entries, checks each candidate folder
 * against the scan rules *before* importing anything, then `await import()`s each surviving entry module
 * and assembles a registry entry in the seam's `StepPlugin` shape.
 *
 * Wired on the production load path (#337): the async `loadWorkflowTree` freeze point calls this to
 * build the file schema (ADR 0019 sub-15), and `runWorkflow` calls it again to get the executor
 * registry it dispatches every leaf step through. Its adequacy is also proven by unit tests against
 * fixture directories.
 *
 * Everything here is a **hard** failure. A folder present on disk but broken fails the whole scan
 * naming the folder and the reason (ADR 0019 sub-16); there is no skip-with-warning, because a skipped
 * plugin degrades into the "unknown step type" message `@path/schema` cannot tell from a genuinely
 * absent type (ADR 0018 sub-5).
 */

/** The registry the scan builds: leaf step-type name → its loaded plugin. Keyed by folder name (ADR 0019 sub-2). */
export type LoadedStepPluginRegistry = Record<string, StepPlugin>;

/**
 * The one fixed location, resolved relative to `import.meta.url` and never `process.cwd()` (ADR 0019
 * sub-8): a cwd-relative resolution would make the set of valid step types depend on the operator's
 * shell directory. From `src/plugin/scan.ts`, the plugins root is two directories up.
 */
export const STEP_PLUGINS_DIR = fileURLToPath(new URL("../../step-plugins/", import.meta.url));

// The folder name becomes a `z.literal` and a `type` value in author-written JSON, so it must look like
// a core type name (ADR 0019 sub-13). All eight core names already match this shape.
const FOLDER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// The six control-construct names a folder can never legitimately be (ADR 0019 sub-14). `binary` and
// `prompt` are *not* here — sub-10 makes them ordinary folders.
const RESERVED_NAMES = new Set<string>(RESERVED_TYPE_NAMES);

// The single conventional entry module (ADR 0019 sub-3). One path, probed once, no ordered fallback.
const ENTRY_FILE = "index.ts";

// The named export the engine reads (ADR 0019 sub-4). Not a default export: greppable, barrel-safe, and
// leaves the module free to add sibling exports.
const PLUGIN_EXPORT = "stepPlugin";

/**
 * Scan the fixed plugin directory (or an explicit `dir`, for tests) and return the frozen registry.
 *
 * Directories only; dot-prefixed skipped; sorted lexicographically before loading, so the first-reported
 * error is stable across machines whose `readdir` order differs (ADR 0019 sub-12). The folder-name and
 * reserved-name checks run *before* the import, so a folder named `while-do` reports the reserved name
 * even when its own `index.ts` would also throw (ADR 0019 sub-14).
 */
export async function scanStepPlugins(dir: string = STEP_PLUGINS_DIR): Promise<LoadedStepPluginRegistry> {
  const entries = await readdir(dir, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

  const registry: LoadedStepPluginRegistry = {};
  for (const name of folders) {
    if (!FOLDER_NAME_PATTERN.test(name)) {
      throw new Error(
        `step plugin "${name}": folder name must match ${FOLDER_NAME_PATTERN.source} — a step type name ` +
          `is a lowercase identifier, so it can be a JSON \`type\` value`,
      );
    }
    // Before the import: the verdict must not depend on whether the offending plugin happens to load.
    if (RESERVED_NAMES.has(name)) {
      throw new Error(
        `step plugin "${name}": name shadows a reserved control construct — the six control names ` +
          `(${RESERVED_TYPE_NAMES.join(", ")}) cannot be a plugin folder`,
      );
    }
    registry[name] = await loadPlugin(name, join(dir, name));
  }

  return registry;
}

// Load one surviving folder: probe the single entry file, import it under a change-keyed URL, and read
// the named export into a registry entry. Each failure class throws with the folder name and the reason.
async function loadPlugin(name: string, folder: string): Promise<StepPlugin> {
  const entry = join(folder, ENTRY_FILE);

  let entryStat;
  try {
    entryStat = await stat(entry);
  } catch (err) {
    // Only a genuine absence is "no index.ts". A permission or broken-symlink error names its own
    // cause, so it is not masked into a message that sends the operator to create a file that exists.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`step plugin "${name}": no ${ENTRY_FILE} in ${folder}`);
    }
    throw new Error(`step plugin "${name}": cannot read ${ENTRY_FILE} in ${folder} — ${describeError(err)}`);
  }
  if (!entryStat.isFile()) {
    throw new Error(`step plugin "${name}": ${ENTRY_FILE} in ${folder} is not a file`);
  }

  const url = await entryImportUrl(folder, entry);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`step plugin "${name}": ${ENTRY_FILE} threw at import — ${describeError(err)}`);
  }

  const plugin = mod[PLUGIN_EXPORT];
  if (plugin === undefined) {
    throw new Error(`step plugin "${name}": ${ENTRY_FILE} has no named \`${PLUGIN_EXPORT}\` export`);
  }
  if (!isStepPluginShape(plugin)) {
    throw new Error(
      `step plugin "${name}": \`${PLUGIN_EXPORT}\` export is malformed — expected ` +
        `{ fields, config, workers, defaultWorker } (an object of zod shapes, a worker map, and a default worker name)`,
    );
  }

  return plugin;
}

/**
 * The change-keyed import URL for a plugin entry (ADR 0019 sub-17): `pathToFileURL(entry).href` plus a
 * `?v=` token that is the **maximum mtime across the folder tree**. An unchanged folder yields the same
 * URL and hits Node's ESM cache — no re-execution — so the module map grows with the number of *edits*,
 * not the number of loads. The N loads inside one `GET /v0/workflows` call share one import.
 *
 * **Freshness limit (documented, not fixed here):** Node does not propagate the query string to
 * relative specifiers, so `index.ts?v=2` importing `./helpers.ts` resolves without the query and hits
 * the cached copy. The entry module refreshes on any change within its folder; modules it imports from
 * beside it refresh only on process restart.
 *
 * Exported so a test can assert the token is stable for an unchanged folder and changes after an edit —
 * the mechanism the freshness contract rests on. Whether a new token *re-executes* is Node's ESM-cache
 * behavior, not the scanner's.
 */
export async function entryImportUrl(folder: string, entry: string = join(folder, ENTRY_FILE)): Promise<string> {
  // Floor to integer milliseconds: a fractional token would put a `.` in the query, and an ESM loader
  // that sniffs the specifier's extension reads the trailing digits as one. Millisecond resolution is
  // ample for a cache key — two edits inside one millisecond are one edit as far as the module map cares.
  const token = Math.floor(await maxMtimeMs(folder));
  return `${pathToFileURL(entry).href}?v=${token}`;
}

// The maximum mtime across a folder tree. Directory mtimes are included so an added or removed file —
// which changes the containing directory's mtime but not any surviving file's — still moves the token.
async function maxMtimeMs(dir: string): Promise<number> {
  let max = (await stat(dir)).mtimeMs;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      max = Math.max(max, await maxMtimeMs(child));
    } else {
      max = Math.max(max, (await stat(child)).mtimeMs);
    }
  }
  return max;
}

// A shallow structural check on the export. It gates only the four seam keys the scanner assembles; the
// deeper invariants — a `fields` key colliding with `commonStepFields`, a type shipping no worker — are
// the schema factory's, thrown when `makeWorkflowFileSchema(registry)` freezes (ADR 0018 sub-4).
function isStepPluginShape(value: unknown): value is StepPlugin {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isPlainRecord(candidate.fields) &&
    isPlainRecord(candidate.config) &&
    isPlainRecord(candidate.workers) &&
    typeof candidate.defaultWorker === "string"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
