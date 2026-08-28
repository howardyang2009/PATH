/**
 * One-time codemod for the workflow-format @3 migration — the worker-name model (ADR 0021,
 * workflow-format-v3.md §1). A worker is a *name* now, not a tagged object, and `model`/`options`
 * move to config.
 *
 * Rewrites every `*.workflow.json` in this repo from `path/workflow@2` to `path/workflow@3`:
 *
 *   - bumps `format` to `path/workflow@3`;
 *   - **deletes a `worker: {type:"engine"}`** wherever it appears (file level or a step) — the step
 *     reaches its type's default worker, which is what `engine` selected;
 *   - **rewrites a `worker: {type:"llm", model, options?}`** by deleting the key and writing its
 *     `model` / `options` into that same object's *own* `config` — the file's config for a file-level
 *     worker, the step's config for a step-level one;
 *   - **deletes `worker` on a `workflow` step** outright — a workflow step runs a nested run, not a
 *     worker (`@3` §4).
 *
 * It **never writes a `worker` name string**: every `@2` file reaches its type's default worker,
 * because `@2` shipped one reachable implementation per type. The name field is only ever *deleted*.
 *
 * **Refuses rather than guessing.** It hard-fails, naming the file and the JSON pointer, on two
 * classes it cannot rewrite honestly (ADR 0021 sub-12):
 *
 *   - **An interpolated `model` or `options`.** Config is literal (`@3` §8), so hoisting a `${…}`
 *     expression into config writes an inert string that no longer resolves — a silent behaviour
 *     change. The one benign sub-case is a `model` that is *exactly* `"${config.model}"` where
 *     `config.model` already resolves in scope: the hoist is then a no-op (the effective `config.model`
 *     already drives the step) and the key is simply deleted.
 *   - **A `prompt` step whose effective worker is `engine`.** It load-passes and run-fails today; after
 *     migration it would silently run on `sdk`, spending money the author never authorised. The codemod
 *     stops rather than migrate it.
 *
 * A refusal leaves the file byte-unchanged and exits 1. Across this repo's files none fires, so the
 * strict rule costs nothing today and closes both silent-change classes forever.
 *
 * Idempotent: a file already at `@3` (or still at `@0`/`@1`) is left untouched.
 *
 * Usage:  pnpm tsx scripts/migrate-workflow-format-v3.ts [file ...]
 *   With no arguments it discovers every tracked `*.workflow.json` under the repo root.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_FORMAT = "path/workflow@2";
const NEXT_FORMAT = "path/workflow@3";

// A `model` that is exactly this, with `config.model` resolving in scope, is the benign no-op hoist:
// the effective `config.model` already drives the step, so the worker key is simply deleted.
const BENIGN_MODEL = "${config.model}";

type JsonObject = { [key: string]: unknown };

/** Thrown when a file cannot be migrated without guessing — reported, and the file is left as-is. */
class MigrationRefused extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Does any string anywhere within a value carry a `${…}` interpolation? */
function hasInterpolation(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${");
  if (Array.isArray(value)) return value.some(hasInterpolation);
  if (isObject(value)) return Object.values(value).some(hasInterpolation);
  return false;
}

/** Write one key into an object's own `config`, creating the config map if it has none. */
function writeConfig(obj: JsonObject, key: string, value: unknown): void {
  const config = isObject(obj.config) ? obj.config : {};
  config[key] = value;
  obj.config = config;
}

interface Ctx {
  /** The file-level worker's `type`, read before it is deleted — a step with no own worker inherits it. */
  fileWorkerType: string | undefined;
  /** Whether `config.model` resolves at the file level (after the file worker's own hoist). */
  fileConfigHasModel: boolean;
}

/**
 * Rewrite one worker-bearing object (the file, or a `binary`/`prompt` step) in place. `pointer` is the
 * JSON pointer of its `worker` key. `effectiveConfigHasModel` is whether `config.model` resolves in
 * this object's scope (file config merged with the object's own). `isPromptStep` gates the
 * engine-worker refusal — only a `prompt` step run on `engine` is a silent paid-worker change.
 */
function rewriteWorker(
  obj: JsonObject,
  pointer: string,
  effectiveConfigHasModel: boolean,
  isPromptStep: boolean,
  fileWorkerType: string | undefined,
): void {
  const worker = obj.worker;

  if (worker === undefined) {
    // No own worker: the step inherits the file worker. A prompt step inheriting `engine` is the
    // silent-paid-worker case the codemod refuses (it run-fails today, would run on `sdk` after).
    if (isPromptStep && fileWorkerType === "engine") {
      throw new MigrationRefused(
        `${pointer}: a prompt step whose effective worker is "engine" would silently run on "sdk" after migration (ADR 0021 sub-12)`,
      );
    }
    return;
  }
  if (!isObject(worker) || typeof worker.type !== "string") return; // already a name, or hand-broken — leave it

  if (worker.type === "engine") {
    if (isPromptStep) {
      throw new MigrationRefused(
        `${pointer}: a prompt step whose effective worker is "engine" would silently run on "sdk" after migration (ADR 0021 sub-12)`,
      );
    }
    delete obj.worker;
    return;
  }

  if (worker.type === "llm") {
    const model = worker.model;
    if (typeof model === "string" && model.includes("${")) {
      // Interpolated model. The one benign case: exactly `${config.model}` with `config.model` in
      // scope — the effective config already drives the step, so deleting the key is a no-op hoist.
      if (!(model === BENIGN_MODEL && effectiveConfigHasModel)) {
        throw new MigrationRefused(
          `${pointer}/model: an interpolated model ${JSON.stringify(model)} cannot be hoisted into literal config without guessing (ADR 0021 sub-12)`,
        );
      }
    } else if (model !== undefined) {
      writeConfig(obj, "model", model); // literal model → this object's own config
    }

    const options = worker.options;
    if (options !== undefined) {
      if (hasInterpolation(options)) {
        throw new MigrationRefused(
          `${pointer}/options: an interpolated options bag cannot be hoisted into literal config without guessing (ADR 0021 sub-12)`,
        );
      }
      writeConfig(obj, "options", options);
    }

    delete obj.worker;
    return;
  }

  // An unrecognised worker type (not `engine`/`llm`) is a hand-broken `@2` file — leave it and let the
  // `@3` schema reject the load, rather than guess a rewrite.
}

function walkNode(node: unknown, pointer: string, ctx: Ctx): void {
  if (!isObject(node)) return;

  if (node.type === "workflow") {
    // A workflow step runs a nested run, not a worker (`@3` §4): its `worker` is deleted outright, with
    // no hoist — a workflow step's worker never crossed the file boundary, so it drove nothing.
    if (node.worker !== undefined) delete node.worker;
  } else if (node.type === "binary" || node.type === "prompt") {
    const isPrompt = node.type === "prompt";
    const stepHasModel = isObject(node.config) && "model" in node.config;
    rewriteWorker(node, `${pointer}/worker`, ctx.fileConfigHasModel || stepHasModel, isPrompt, ctx.fileWorkerType);
  }

  // Recurse into every nested-node slot (`@2` §4.3/§4.4): a step carries none, a logicer does.
  if (Array.isArray(node.branches)) walkNodeArray(node.branches, `${pointer}/branches`, ctx);
  if (Array.isArray(node.arms)) {
    node.arms.forEach((arm, index) => {
      if (isObject(arm)) walkNode(arm.node, `${pointer}/arms/${index}/node`, ctx);
    });
  }
  if (node.else !== undefined) walkNode(node.else, `${pointer}/else`, ctx);
  if (node.type === "while-do") walkNode(node.node, `${pointer}/node`, ctx);
  if (Array.isArray(node.body)) walkNodeArray(node.body, `${pointer}/body`, ctx);
}

function walkNodeArray(nodes: unknown[], pointer: string, ctx: Ctx): void {
  nodes.forEach((node, index) => walkNode(node, `${pointer}/${index}`, ctx));
}

/** @returns the migrated document, or null when the file is not a `@2` workflow (already `@3`, or `@0`/`@1`). */
function migrateDocument(doc: unknown): JsonObject | null {
  if (!isObject(doc) || doc.format !== LEGACY_FORMAT) return null;

  const migrated: JsonObject = { ...doc, format: NEXT_FORMAT };

  // The file worker is read (its `type`) then rewritten first, so a file-level llm `model` lands in
  // `config` before the benign step check reads `config.model`, and a step's inherited worker type is
  // known when the step carries no `worker` of its own.
  const fileWorkerType = isObject(migrated.worker) && typeof migrated.worker.type === "string" ? migrated.worker.type : undefined;
  const fileConfigHasModelBefore = isObject(migrated.config) && "model" in migrated.config;
  rewriteWorker(migrated, "/worker", fileConfigHasModelBefore, false, undefined);

  const ctx: Ctx = {
    fileWorkerType,
    fileConfigHasModel: isObject(migrated.config) && "model" in migrated.config,
  };
  if (Array.isArray(migrated.body)) walkNodeArray(migrated.body, "/body", ctx);
  return migrated;
}

function discoverWorkflowFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...discoverWorkflowFiles(full));
    else if (entry.name.endsWith(".workflow.json")) found.push(full);
  }
  return found;
}

function main(): void {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args.map((a) => resolve(a)) : discoverWorkflowFiles(process.cwd());

  let migrated = 0;
  let skipped = 0;
  const refused: string[] = [];
  for (const file of files) {
    const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
    let result: JsonObject | null;
    try {
      result = migrateDocument(doc);
    } catch (err) {
      if (err instanceof MigrationRefused) {
        refused.push(`${file}: ${err.message}`);
        continue;
      }
      throw err;
    }
    if (result === null) {
      skipped += 1;
      continue;
    }
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    migrated += 1;
    console.log(`migrated ${file}`);
  }
  console.log(`\n${migrated} migrated, ${skipped} already at ${NEXT_FORMAT} (or not a @2 workflow file).`);
  if (refused.length > 0) {
    console.error(`\n${refused.length} refused:`);
    for (const line of refused) console.error(`  ${line}`);
    process.exitCode = 1;
  }
}

// Import-safe: run only when invoked directly, so the codemod's unit test can import `migrateDocument`
// without the discovery/main side effects (its `@2`/`@3` predecessors run on import; this one guards).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

export { migrateDocument, MigrationRefused };
