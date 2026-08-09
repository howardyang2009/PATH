/**
 * One-time codemod for the workflow-format identity migration (ADR 0006/0007, #204).
 *
 * Rewrites every `*.workflow.json` in this repo from `path/workflow@0` to `path/workflow@1`:
 *
 *   - bumps `format` to `path/workflow@1`;
 *   - stamps a fresh `randomUUID()` as the durable `id` on the workflow and on every node/branch;
 *   - moves each node/branch's old human `id` to `name` (the workflow already had `name`).
 *
 * This is the *only* sanctioned write-back of an `id` (ADR 0006: fill-once, never regenerate). It is
 * a committed repo-internal script, not a shipped `path migrate` command — pre-1.0 there are no
 * external stored workflow files, and #202's schema v4 bump resets `.path/path.db`, so no resume
 * continuity spans the migration and no id-preservation mapping is needed.
 *
 * Idempotent: a file already at `@1` is left untouched, so a re-run never regenerates an id.
 *
 * Usage:  pnpm tsx scripts/migrate-workflow-format-v1.ts [file ...]
 *   With no arguments it discovers every tracked `*.workflow.json` under the repo root.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LEGACY_FORMAT = "path/workflow@0";
const NEXT_FORMAT = "path/workflow@1";

type Json = { [key: string]: unknown } | unknown[] | string | number | boolean | null;

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rebuild an object with `id`/`name` leading, a fresh GUID `id`, and the old human `id` as `name`. */
function withStampedIdentity(node: { [key: string]: unknown }): { [key: string]: unknown } {
  const oldHumanId = node.id;
  const name = node.name ?? oldHumanId;
  const rest: { [key: string]: unknown } = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "id" || key === "name" || key === "type") continue;
    rest[key] = value;
  }
  const rebuilt: { [key: string]: unknown } = {};
  if (typeof node.type === "string") rebuilt.type = node.type;
  rebuilt.id = randomUUID();
  rebuilt.name = name;
  Object.assign(rebuilt, rest);
  return rebuilt;
}

/** Recurse into every nested body a control node carries (mirrors schema `childBodies`). */
function migrateChildBodies(node: { [key: string]: unknown }): void {
  if (Array.isArray(node.branches)) {
    node.branches = node.branches.map((branch) => {
      if (!isObject(branch)) return branch;
      const stamped = withStampedIdentity(branch);
      if (Array.isArray(stamped.body)) stamped.body = migrateNodeArray(stamped.body);
      return stamped;
    });
  }
  if (Array.isArray(node.arms)) {
    node.arms = node.arms.map((arm) => {
      if (isObject(arm) && Array.isArray(arm.body)) return { ...arm, body: migrateNodeArray(arm.body) };
      return arm;
    });
  }
  if (Array.isArray(node.else)) node.else = migrateNodeArray(node.else);
  if (Array.isArray(node.body)) node.body = migrateNodeArray(node.body);
}

function migrateNodeArray(nodes: unknown[]): unknown[] {
  return nodes.map((node) => {
    if (!isObject(node)) return node;
    const stamped = withStampedIdentity(node);
    migrateChildBodies(stamped);
    return stamped;
  });
}

/** @returns the migrated document, or null when the file is not a legacy workflow (already `@1`). */
function migrateDocument(doc: unknown): { [key: string]: unknown } | null {
  if (!isObject(doc) || doc.format !== LEGACY_FORMAT) return null;
  const { format: _f, id: _i, name, worker, config, body, output, ...rest } = doc;
  const migrated: { [key: string]: unknown } = { format: NEXT_FORMAT, id: randomUUID(), name };
  if (worker !== undefined) migrated.worker = worker;
  if (config !== undefined) migrated.config = config;
  if (Array.isArray(body)) migrated.body = migrateNodeArray(body);
  else if (body !== undefined) migrated.body = body;
  if (output !== undefined) migrated.output = output;
  Object.assign(migrated, rest); // preserve any unknown fields verbatim (e.g. an invalid-schema probe)
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
  for (const file of files) {
    const doc = JSON.parse(readFileSync(file, "utf8")) as Json;
    const result = migrateDocument(doc);
    if (result === null) {
      skipped += 1;
      continue;
    }
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    migrated += 1;
    console.log(`migrated ${file}`);
  }
  console.log(`\n${migrated} migrated, ${skipped} already at ${NEXT_FORMAT} (or not a workflow file).`);
}

main();
