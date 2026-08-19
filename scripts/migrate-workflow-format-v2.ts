/**
 * One-time codemod for the workflow-format @2 migration — uniform single-node container slots and the
 * `sequence` logicer (workflow-format-v2.md §0, §11; ADR 0014).
 *
 * Rewrites every `*.workflow.json` in this repo from `path/workflow@1` to `path/workflow@2`:
 *
 *   - bumps `format` to `path/workflow@2`;
 *   - **unwraps each `parallel` branch**: the `@1` wrapper `{ id, name, body }` — a thing that was not
 *     itself a node — becomes the branch's single node directly in `branches`. When the wrapper held
 *     exactly one node, that node *is* the branch, and it is **renamed to the wrapper's `name`** so the
 *     `collect` / `wait-one` output key (which in `@1` was the wrapper's name, §4.3) is byte-preserved.
 *     When the wrapper held several nodes, the wrapper becomes a `sequence` carrying the same `id` +
 *     `name` (its shape was already a sequence's).
 *   - converts every **single-`node` slot** — a `branch` arm's occupant, a `branch`'s `else`, and a
 *     `while-do`'s body — from the `@1` node array to one node: a lone node directly, several wrapped
 *     in a minted `sequence` (§3.1, §4.3).
 *   - leaves the two node-array slots alone: the file's top-level `body` and a `sequence`'s `body` (§0).
 *
 * Unlike its `@0`→`@1` predecessor `scripts/migrate-workflow-format-v1.ts`, this codemod **preserves
 * ids** — every node already carries its durable GUID (ADR 0006, fill-once), so nothing is
 * regenerated. Only minted `sequence` nodes get a fresh `randomUUID()`.
 *
 * **Refuses rather than inventing.** If unwrapping a branch would rename its node to a `name` that
 * already exists elsewhere in the file, the codemod stops and reports the file rather than minting a
 * disambiguated name (§11). Across this repo's files no such collision occurs and no `sequence` is
 * minted.
 *
 * Idempotent: a file already at `@2` (or still at `@0`) is left untouched.
 *
 * Usage:  pnpm tsx scripts/migrate-workflow-format-v2.ts [file ...]
 *   With no arguments it discovers every tracked `*.workflow.json` under the repo root.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LEGACY_FORMAT = "path/workflow@1";
const NEXT_FORMAT = "path/workflow@2";

type JsonObject = { [key: string]: unknown };

/** Thrown when a file cannot be migrated without inventing a name — reported, and the file is left as-is. */
class MigrationRefused extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The names already in use across the whole file (§3: `name` is unique at every nesting level). Built
 * from the pre-migration document so a minted `sequence` name can be disambiguated against it, and so
 * a branch rename can be checked for collision. Includes `@1` branch-wrapper names — they occupied the
 * same namespace even though the wrapper was not a node.
 */
function collectNames(doc: JsonObject): Set<string> {
  const names = new Set<string>();
  const visitArray = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) visitNode(node);
  };
  const visitNode = (node: unknown): void => {
    if (!isObject(node)) return;
    if (typeof node.name === "string") names.add(node.name);
    visitArray(node.branches);
    if (Array.isArray(node.arms)) {
      for (const arm of node.arms) if (isObject(arm)) visitArray(arm.body);
    }
    visitArray(node.else);
    visitArray(node.body);
  };
  visitArray(doc.body);
  return names;
}

interface Ctx {
  used: Set<string>;
}

/** A file-unique `name` for a minted `sequence`, derived from its owner and disambiguated if needed. */
function mintName(base: string, ctx: Ctx): string {
  let candidate = base;
  let suffix = 2;
  while (ctx.used.has(candidate)) candidate = `${base}-${suffix++}`;
  ctx.used.add(candidate);
  return candidate;
}

/**
 * Collapse a `@1` node array standing in a single-`node` slot (an arm, an `else`, a `while-do` body)
 * into one node: a lone node passes through; several become a minted `sequence` carrying them in order.
 */
function toSingleNode(nodes: unknown[], baseName: string, ctx: Ctx): unknown {
  const migrated = migrateNodeArray(nodes, ctx);
  if (migrated.length === 1) return migrated[0];
  return { type: "sequence", id: randomUUID(), name: mintName(baseName, ctx), body: migrated };
}

/** Unwrap one `@1` `parallel` branch wrapper into the `@2` branch node (single node, or a `sequence`). */
function unwrapBranch(branch: unknown, ctx: Ctx): unknown {
  if (!isObject(branch)) return branch;
  const wrapperName = branch.name;
  const migratedBody = Array.isArray(branch.body) ? migrateNodeArray(branch.body, ctx) : [];
  if (migratedBody.length === 1 && isObject(migratedBody[0])) {
    // The single occupant *is* the branch. Rename it to the wrapper's name to preserve the collect key.
    const node = migratedBody[0];
    node.name = wrapperName ?? node.name;
    return node;
  }
  // Several nodes (or none) — the wrapper already had a sequence's shape, so tag it as one.
  return { type: "sequence", id: branch.id ?? randomUUID(), name: wrapperName, body: migratedBody };
}

/**
 * The first `name` borne by two `@2` nodes, or null when every name is unique (§3). A branch unwrap
 * renames its node to the wrapper's name; in a valid `@1` file that never collides (names were already
 * file-unique), but a hand-edited file could, and the codemod refuses rather than inventing a
 * disambiguated name (§11).
 */
function findDuplicateName(doc: JsonObject): string | null {
  const seen = new Set<string>();
  let duplicate: string | null = null;
  const visitArray = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) visitNode(node);
  };
  const visitNode = (node: unknown): void => {
    if (!isObject(node) || duplicate !== null) return;
    if (typeof node.name === "string") {
      if (seen.has(node.name)) duplicate ??= node.name;
      seen.add(node.name);
    }
    visitArray(node.branches);
    if (Array.isArray(node.arms)) {
      for (const arm of node.arms) if (isObject(arm)) visitNode(arm.node);
    }
    visitNode(node.else);
    visitNode(node.node);
    visitArray(node.body);
  };
  visitArray(doc.body);
  return duplicate;
}

/** Recurse into every nested slot a node carries, converting `@1` shapes to `@2` in place. */
function migrateChildBodies(node: JsonObject, ctx: Ctx): void {
  if (Array.isArray(node.branches)) {
    node.branches = node.branches.map((branch) => unwrapBranch(branch, ctx));
  }
  if (Array.isArray(node.arms)) {
    node.arms = node.arms.map((arm) => {
      if (isObject(arm) && Array.isArray(arm.body)) {
        const { body, ...rest } = arm;
        return { ...rest, node: toSingleNode(body, `${asName(node.name)}-arm`, ctx) };
      }
      return arm;
    });
  }
  if (Array.isArray(node.else)) node.else = toSingleNode(node.else, `${asName(node.name)}-else`, ctx);
  if (node.type === "while-do" && Array.isArray(node.body)) {
    node.node = toSingleNode(node.body, `${asName(node.name)}-body`, ctx);
    delete node.body;
  } else if (Array.isArray(node.body)) {
    // A `sequence`'s body (only present if the file was already partly `@2`) or any other node-array
    // stays an array of migrated nodes.
    node.body = migrateNodeArray(node.body, ctx);
  }
}

function asName(value: unknown): string {
  return typeof value === "string" ? value : "seq";
}

function migrateNodeArray(nodes: unknown[], ctx: Ctx): unknown[] {
  return nodes.map((node) => {
    if (!isObject(node)) return node;
    migrateChildBodies(node, ctx);
    return node;
  });
}

/** @returns the migrated document, or null when the file is not a `@1` workflow (already `@2`, or `@0`). */
function migrateDocument(doc: unknown): JsonObject | null {
  if (!isObject(doc) || doc.format !== LEGACY_FORMAT) return null;
  const ctx: Ctx = { used: collectNames(doc) };
  const migrated: JsonObject = { ...doc, format: NEXT_FORMAT };
  if (Array.isArray(migrated.body)) migrated.body = migrateNodeArray(migrated.body, ctx);
  const collision = findDuplicateName(migrated);
  if (collision !== null) {
    throw new MigrationRefused(`unwrapping a branch to "${collision}" would collide with an existing name — file left unchanged`);
  }
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
  console.log(`\n${migrated} migrated, ${skipped} already at ${NEXT_FORMAT} (or not a @1 workflow file).`);
  if (refused.length > 0) {
    console.error(`\n${refused.length} refused:`);
    for (const line of refused) console.error(`  ${line}`);
    process.exitCode = 1;
  }
}

main();
