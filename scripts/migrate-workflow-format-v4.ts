/**
 * One-time codemod for the workflow-format @4 migration — the file-level `worker_defaults` table
 * (ADR 0044, workflow-format-v4.md). `worker_defaults` is a new *optional* envelope key, so a `@3`
 * file's existing shape is already a valid `@4` file: nothing in the body, config, or output moves.
 *
 * Per #501 an envelope grammar change bumps the format version even when the migration is empty, so
 * the version moves `@3` → `@4` and this codemod exists only to stamp it. It is therefore a
 * **no-op format stamp**:
 *
 *   - it rewrites `format` to `path/workflow@4` and touches nothing else;
 *   - it **refuses nothing** — there is no shape it cannot carry forward honestly;
 *   - it is **idempotent** — a file already at `@4` (or still at an older `@0`/`@1`/`@2` string,
 *     which is an earlier codemod's step) is left byte-unchanged.
 *
 * Usage:  pnpm tsx scripts/migrate-workflow-format-v4.ts [file ...]
 *   With no arguments it discovers every tracked `*.workflow.json` under the repo root.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_FORMAT = "path/workflow@3";
const NEXT_FORMAT = "path/workflow@4";

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @returns the migrated document, or null when the file is not a `@3` workflow (already `@4`, or older). */
function migrateDocument(doc: unknown): JsonObject | null {
  if (!isObject(doc) || doc.format !== LEGACY_FORMAT) return null;
  // A no-op stamp: only `format` moves, every other key is carried through in place.
  return { ...doc, format: NEXT_FORMAT };
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
  const files =
    args.length > 0 ? args.map((a) => resolve(a)) : discoverWorkflowFiles(process.cwd());

  let migrated = 0;
  let skipped = 0;
  for (const file of files) {
    const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const result = migrateDocument(doc);
    if (result === null) {
      skipped += 1;
      continue;
    }
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    migrated += 1;
    console.log(`migrated ${file}`);
  }
  console.log(
    `\n${migrated} migrated, ${skipped} already at ${NEXT_FORMAT} (or not a @3 workflow file).`,
  );
}

// Import-safe: run only when invoked directly, so the codemod's unit test can import `migrateDocument`
// without the discovery/main side effects.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

export { migrateDocument };
