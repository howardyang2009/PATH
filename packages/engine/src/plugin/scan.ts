import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RESERVED_TYPE_NAMES } from "@path/schema";

import type { StepPlugin } from "./seam.js";

/**
 * Scans the one fixed plugin directory (ADR 0019 sub-7–17): checks every candidate folder *before*
 * importing, then assembles the frozen registry the load/run paths dispatch through. A broken folder
 * fails the whole scan rather than being skipped, which would degrade into a misleading "unknown type". */

/** The registry the scan builds: leaf step-type name → its loaded plugin, keyed by folder name (ADR 0019 sub-2). */
export type LoadedStepPluginRegistry = Record<string, StepPlugin>;

/** The one fixed location, resolved relative to `import.meta.url`, never `process.cwd()` (ADR 0019 sub-8):
 * a cwd-relative resolution would make valid step types depend on the operator's shell directory. */
export const STEP_PLUGINS_DIR = fileURLToPath(
  new URL("../../plugin/step-plugin/", import.meta.url),
);

// The folder name becomes a `z.literal` and a JSON `type` value, so it must look like a core type name (ADR 0019
// sub-13).
const FOLDER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// The control-construct names a folder can never legitimately be; `binary`/`prompt` are ordinary folders (ADR 0019
// sub-10/sub-14).
const RESERVED_NAMES = new Set<string>(RESERVED_TYPE_NAMES);

// The single conventional entry module — one path, probed once, no ordered fallback (ADR 0019 sub-3).
const ENTRY_FILE = "index.ts";

// The named export the engine reads — greppable, barrel-safe, and leaves the module free to add sibling exports (ADR
// 0019 sub-4).
const PLUGIN_EXPORT = "stepPlugin";

/** Scan the fixed plugin directory (or an explicit `dir`, for tests) and return the frozen registry.
 * Directories only, dot-prefixed skipped, sorted before loading so the first error is machine-stable;
 * the name checks run *before* the import, so a reserved name reports even if `index.ts` would throw. */
export async function scanStepPlugins(
  dir: string = STEP_PLUGINS_DIR,
): Promise<LoadedStepPluginRegistry> {
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
        `step plugin "${name}": name shadows a reserved control construct — the seven control names ` +
          `(${RESERVED_TYPE_NAMES.join(", ")}) cannot be a plugin folder`,
      );
    }
    registry[name] = await loadPlugin(name, join(dir, name));
  }

  return registry;
}

// Load one surviving folder: probe the single entry file, import it under a change-keyed URL, read the named export.
async function loadPlugin(name: string, folder: string): Promise<StepPlugin> {
  const entry = join(folder, ENTRY_FILE);

  let entryStat: Awaited<ReturnType<typeof stat>>;
  try {
    entryStat = await stat(entry);
  } catch (err) {
    // Only a genuine absence is "no index.ts" — a permission or broken-symlink error names its own cause.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`step plugin "${name}": no ${ENTRY_FILE} in ${folder}`);
    }
    throw new Error(
      `step plugin "${name}": cannot read ${ENTRY_FILE} in ${folder} — ${describeError(err)}`,
    );
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
    throw new Error(
      `step plugin "${name}": ${ENTRY_FILE} has no named \`${PLUGIN_EXPORT}\` export`,
    );
  }
  if (!isStepPluginShape(plugin)) {
    throw new Error(
      `step plugin "${name}": \`${PLUGIN_EXPORT}\` export is malformed — expected ` +
        `{ fields, config, workers, defaultWorker } (an object of zod shapes, a worker map, and a default worker name)`,
    );
  }

  return plugin;
}

/** The change-keyed import URL (ADR 0019 sub-17): the file URL plus a `?v=` token that is the max mtime across
 * the folder tree, so an unchanged folder hits Node's ESM cache. Node does not propagate the query to relative
 * specifiers, so modules imported beside the entry refresh only on process restart. Exported for tests to assert. */
export async function entryImportUrl(
  folder: string,
  entry: string = join(folder, ENTRY_FILE),
): Promise<string> {
  // Floor to integer milliseconds: a fractional token puts a `.` in the query, which an ESM loader that sniffs
  // the specifier's extension misreads. Millisecond resolution is ample for a cache key.
  const token = Math.floor(await maxMtimeMs(folder));
  return `${pathToFileURL(entry).href}?v=${token}`;
}

// The max mtime across a folder tree. Directory mtimes count too, so an added or removed file moves the token.
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

/** The read-only registry snapshot behind `GET /v0/step-plugins` (server-api-v0.md §8, ADR 0018): the browser
 * Designer cannot scan the plugin folder, so the server reads it here and serves the authoring palette. A broken
 * folder throws exactly as on the load/run paths, so a server fails loud rather than serving a partial registry. */
export function loadStepPluginRegistry(): Promise<LoadedStepPluginRegistry> {
  return scanStepPlugins();
}

// A shallow structural check gating only the four seam keys; the deeper invariants (a `fields` key colliding
// with `commonStepFields`, a type shipping no worker) belong to the schema factory at freeze time (ADR 0018 sub-4).
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
