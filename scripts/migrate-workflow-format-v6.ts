/**
 * One-time codemod for the workflow-format @6 migration — the `previous` root (ADR 0079). `@6`
 * removes `output` from the condition roots: a condition names its predecessor's output
 * `previous`, and `output` means only a step's own output, read in `publish`.
 *
 * So the codemod:
 *
 *   - rewrites `format` to `path/workflow@6`;
 *   - rewrites every condition leaf path rooted at `output` (`output`, `output.x`) to the same
 *     path rooted at `previous`, in a `branch` arm's `when`, a `while-do`'s `condition` and a
 *     `checkpoint`'s `condition`, through `all` / `any` / `not` at any depth;
 *   - touches nothing else. When the rewrite can be made in the text, every other byte survives;
 *     otherwise the file is re-serialized, which is correct but not byte-preserving;
 *   - **refuses nothing** and is **idempotent** — a file already at `@6` (or still at an older
 *     `@0`–`@4` string, which is an earlier codemod's step) is left byte-unchanged.
 *
 * Step-Templates and Workflow-Templates stamp the same `FORMAT_VERSION` (ADR 0048 §1), so they move
 * with workflow files.
 *
 * Usage:  pnpm tsx scripts/migrate-workflow-format-v6.ts [file ...]
 *   With no arguments it discovers every `*.workflow.json`, `*.step-template.json` and
 *   `*.workflow-template.json` under the current directory (skipping dot directories and
 *   `node_modules`) and under its `.path/template/`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const LEGACY_FORMAT = "path/workflow@5";
const NEXT_FORMAT = "path/workflow@6";
const SUFFIXES = [".workflow.json", ".step-template.json", ".workflow-template.json"];

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renameRoot(path: string): string {
  if (path === "output") return "previous";
  if (path.startsWith("output.")) return `previous${path.slice("output".length)}`;
  return path;
}

function migrateCondition(condition: unknown): unknown {
  if (!isObject(condition)) return condition;
  if (condition.type === "all" || condition.type === "any") {
    return Array.isArray(condition.of)
      ? { ...condition, of: condition.of.map(migrateCondition) }
      : condition;
  }
  if (condition.type === "not") return { ...condition, of: migrateCondition(condition.of) };
  return typeof condition.path === "string"
    ? { ...condition, path: renameRoot(condition.path) }
    : condition;
}

/** Rewrites the conditions of every `branch`, `while-do` and `checkpoint` node, at any depth. */
function migrateNodes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(migrateNodes);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) out[key] = migrateNodes(item);
  if (out.type === "branch" && Array.isArray(out.arms)) {
    out.arms = out.arms.map((arm) =>
      isObject(arm) ? { ...arm, when: migrateCondition(arm.when) } : arm,
    );
  }
  if ((out.type === "while-do" || out.type === "checkpoint") && "condition" in out) {
    out.condition = migrateCondition(out.condition);
  }
  return out;
}

/** @returns the migrated file text, or null when the file is not a `@5` document (already `@6`, or
 * older). */
function migrateText(text: string): string | null {
  const doc = JSON.parse(text) as unknown;
  if (!isObject(doc) || doc.format !== LEGACY_FORMAT) return null;
  const expected = { ...(migrateNodes(doc) as JsonObject), format: NEXT_FORMAT };
  // Rewrite in place so every other byte survives: the top-level `format` value, and each
  // `"path": "output…"` pair. If that text rewrite does not produce exactly the structural result
  // (a `path` outside a condition, say), fall back to a re-serialize.
  const stamped = text
    .replace(/("format"\s*:\s*)"path\/workflow@5"/, `$1"${NEXT_FORMAT}"`)
    .replace(/("path"\s*:\s*)"output(?=[."])/g, `$1"previous`);
  if (isDeepStrictEqual(JSON.parse(stamped), expected)) return stamped;
  return `${JSON.stringify(expected, null, 2)}\n`;
}

function discoverFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...discoverFiles(full));
    else if (SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) found.push(full);
  }
  return found;
}

function main(): void {
  const args = process.argv.slice(2);
  const templateDir = join(process.cwd(), ".path", "template");
  const files =
    args.length > 0
      ? args.map((a) => resolve(a))
      : [
          ...discoverFiles(process.cwd()),
          ...(existsSync(templateDir) ? discoverFiles(templateDir) : []),
        ];

  let migrated = 0;
  let skipped = 0;
  for (const file of files) {
    const result = migrateText(readFileSync(file, "utf8"));
    if (result === null) {
      skipped += 1;
      continue;
    }
    writeFileSync(file, result);
    migrated += 1;
    console.log(`migrated ${file}`);
  }
  console.log(`\n${migrated} migrated, ${skipped} already at ${NEXT_FORMAT} (or not a @5 file).`);
}

// Import-safe: run only when invoked directly, so a test can import `migrateText` without the
// discovery/main side effects.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

export { migrateText };
