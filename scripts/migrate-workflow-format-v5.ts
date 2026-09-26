/**
 * One-time codemod for the workflow-format @5 migration — the `goto` controller (ADR 0058,
 * workflow-format-v5.md). `goto` is a new node type, so a `@4` file's existing shape is already a
 * valid `@5` file: nothing in the envelope, body, config, or output moves.
 *
 * Per #501 a grammar change bumps the format version even when the migration is empty, so the
 * version moves `@4` → `@5` and this codemod exists only to stamp it. It is therefore a
 * **no-op format stamp**:
 *
 *   - it rewrites `format` to `path/workflow@5` and touches nothing else — the file's bytes are
 *     carried through, so its own formatting survives;
 *   - it **refuses nothing** — there is no shape it cannot carry forward honestly;
 *   - it is **idempotent** — a file already at `@5` (or still at an older `@0`–`@3` string, which is
 *     an earlier codemod's step) is left byte-unchanged.
 *
 * Step-Templates and Workflow-Templates stamp the same `FORMAT_VERSION` (ADR 0048 §1), so they move
 * with workflow files.
 *
 * Usage:  pnpm tsx scripts/migrate-workflow-format-v5.ts [file ...]
 *   With no arguments it discovers every `*.workflow.json`, `*.step-template.json` and
 *   `*.workflow-template.json` under the current directory (skipping dot directories and
 *   `node_modules`) and under its `.path/template/`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const LEGACY_FORMAT = "path/workflow@4";
const NEXT_FORMAT = "path/workflow@5";
const SUFFIXES = [".workflow.json", ".step-template.json", ".workflow-template.json"];

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @returns the migrated file text, or null when the file is not a `@4` document (already `@5`, or older). */
function migrateText(text: string): string | null {
  const doc = JSON.parse(text) as unknown;
  if (!isObject(doc) || doc.format !== LEGACY_FORMAT) return null;
  const expected = { ...doc, format: NEXT_FORMAT };
  // Rewrite the `format` value in place so every other byte survives. If the first `"format": "@4"`
  // pair is not the top-level one (a nested object that happens to carry one first), fall back to a
  // re-serialize: correct, only not byte-preserving.
  const stamped = text.replace(/("format"\s*:\s*)"path\/workflow@4"/, `$1"${NEXT_FORMAT}"`);
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
  console.log(`\n${migrated} migrated, ${skipped} already at ${NEXT_FORMAT} (or not a @4 file).`);
}

// Import-safe: run only when invoked directly, so a test can import `migrateText` without the
// discovery/main side effects.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

export { migrateText };
