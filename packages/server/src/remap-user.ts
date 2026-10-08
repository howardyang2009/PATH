import {
  copyFileSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createClerkClient } from "@clerk/backend";
import { pathDir } from "@path/engine";
import { type WorkflowNode, walkNodes } from "@path/schema";
import Database from "better-sqlite3";
import { serializeArtifact } from "./artifact-file.js";
import { DEFAULT_USER_ID } from "./authored-layout.js";
import { runningServerPid } from "./server-pid.js";

// The operator's offline move of one user's data to another user id (docs/spec/path-website.md
// §9): `local` to the owner's `sub`, and development ids to production ones. It copies, rewrites the
// copy, verifies it, and only then moves creator rows and, if asked, deletes the source.

export interface RemapPair {
  from: string;
  to: string;
}

/** A `workflow` ref the copy rewrites, the file named by its project path in the target. */
export interface RefRewrite {
  file: string;
  from: string;
  to: string;
}

export interface RemapReport {
  from: string;
  to: string;
  files: number;
  bytes: number;
  /** Rows per table of the user's store. */
  rows: Record<string, number>;
  /** Run rows whose `workflow_path` names the old root. */
  workflowPaths: number;
  refs: RefRewrite[];
  creatorRows: number;
  conflicts: string[];
}

export type RemapUserResult =
  | { success: true; reports: RemapReport[] }
  | { success: false; error: string; reports: RemapReport[] };

export interface RemapUserOptions {
  projectDir: string;
  pairs: RemapPair[];
  dryRun?: boolean;
  deleteSource?: boolean;
}

/** A folder-safe id other than `local`, which only the source of a remap may be. */
const USER_ID = /^[A-Za-z0-9_-]+$/;
// Host-level files in the project `.path`, which stay when `local`'s store moves; `sandbox` holds
// per-run VM staging the Server reaps at boot.
const HOST_ONLY = new Set([
  "host.db",
  "limits.json",
  "quarantine",
  "remove-shared.log",
  "server.pid",
  "sandbox",
]);
const SQLITE_SIDE_FILE = /\.db-(wal|shm|journal)$/;
const EDIT_LEASE = /\.editing$/;
const STORE_DIR = ".path";
const STORE_DB = "path.db";

interface CopyItem {
  src: string;
  /** Relative to the target folder, `/`-separated. */
  dst: string;
  size: number;
}

interface PairPlan {
  pair: RemapPair;
  authoredDir: string;
  storeDir: string;
  targetDir: string;
  items: CopyItem[];
  report: RemapReport;
}

export function remapUser({
  projectDir,
  pairs,
  dryRun = false,
  deleteSource = false,
}: RemapUserOptions): RemapUserResult {
  const project = resolve(projectDir);
  if (!dryRun) {
    const pid = runningServerPid(project);
    if (pid !== undefined) {
      return {
        success: false,
        error: `the Server is running (pid ${pid}); stop it before remap-user`,
        reports: [],
      };
    }
  }

  const plans = pairs.map((pair) => planPair(project, pair, pairs));
  const reports = plans.map((plan) => plan.report);
  if (dryRun) return { success: true, reports };
  const conflicts = plans.flatMap(({ pair, report }) =>
    report.conflicts.map((conflict) => `${pair.from} -> ${pair.to}: ${conflict}`),
  );
  if (conflicts.length > 0) return { success: false, error: conflicts.join("\n"), reports };

  for (const plan of plans) {
    const problems = applyPlan(project, plan);
    if (problems.length > 0) {
      const head = `${plan.pair.from} -> ${plan.pair.to}: the copy in users/${plan.pair.to}/ failed verification; the source and creator rows are unchanged`;
      return { success: false, error: [head, ...problems].join("\n"), reports };
    }
    moveCreatorRows(project, plan.pair);
    if (deleteSource) removeSource(plan);
  }
  return { success: true, reports };
}

function planPair(project: string, pair: RemapPair, all: RemapPair[]): PairPlan {
  const { from, to } = pair;
  const authoredDir = join(project, "users", from);
  const storeDir = from === DEFAULT_USER_ID ? pathDir(project) : join(authoredDir, STORE_DIR);
  const targetDir = join(project, "users", to);
  const report: RemapReport = {
    from,
    to,
    files: 0,
    bytes: 0,
    rows: {},
    workflowPaths: 0,
    refs: [],
    creatorRows: 0,
    conflicts: [],
  };
  const plan: PairPlan = { pair, authoredDir, storeDir, targetDir, items: [], report };

  const badIds = [from, to].filter(
    (id, i) => !USER_ID.test(id) || (i === 1 && id === DEFAULT_USER_ID),
  );
  for (const id of badIds) report.conflicts.push(`"${id}" is not a valid user id`);
  if (badIds.length > 0) return plan;
  if (from === to) report.conflicts.push("the source and target are the same id");
  if (all.filter((other) => other.to === to || other.from === to).length > 1) {
    report.conflicts.push(`users/${to}/ is named more than once`);
  }
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    report.conflicts.push(`users/${to}/ is not empty`);
  }

  plan.items = [
    ...listFiles(authoredDir, (parts) => parts[0] === STORE_DIR).map((rel) =>
      item(authoredDir, rel, rel),
    ),
    ...listFiles(storeDir, (parts) => parts.length === 1 && HOST_ONLY.has(parts[0] as string)).map(
      (rel) => item(storeDir, rel, `${STORE_DIR}/${rel}`),
    ),
  ];
  if (plan.items.length === 0) {
    report.conflicts.push(`users/${from}/ and its store hold nothing to move`);
    return plan;
  }
  report.files = plan.items.length;
  report.bytes = plan.items.reduce((sum, entry) => sum + entry.size, 0);

  const storeDb = join(storeDir, STORE_DB);
  if (existsSync(storeDb)) {
    const db = openExisting(storeDb);
    try {
      report.rows = rowCounts(db);
      if (report.rows.runs !== undefined) {
        const prefix = `users/${from}/`;
        report.workflowPaths = (
          db
            .prepare("SELECT COUNT(*) AS n FROM runs WHERE substr(workflow_path, 1, ?) = ?")
            .get(prefix.length, prefix) as { n: number }
        ).n;
      }
    } finally {
      db.close();
    }
  }
  for (const entry of plan.items) {
    if (!entry.dst.endsWith(".workflow.json") || entry.dst.startsWith(`${STORE_DIR}/`)) continue;
    const raw = parseJson(readFileSync(entry.src, "utf8"));
    if (raw !== undefined) report.refs.push(...rewriteRefs(raw, plan, entry));
  }
  report.creatorRows = withCreatorTable(
    project,
    (db) =>
      (
        db.prepare("SELECT COUNT(*) AS n FROM shared_creators WHERE creator = ?").get(from) as {
          n: number;
        }
      ).n,
  );
  return plan;
}

/** Copies, rewrites and verifies one pair; returns what verification found wrong. */
function applyPlan(project: string, plan: PairPlan): string[] {
  const { pair, targetDir, items } = plan;
  for (const entry of items) {
    const dst = join(targetDir, entry.dst);
    mkdirSync(dirname(dst), { recursive: true });
    if (entry.dst.endsWith(".db")) {
      // VACUUM INTO folds any WAL content into a self-contained copy.
      const db = openExisting(entry.src);
      try {
        db.prepare("VACUUM INTO ?").run(dst);
      } finally {
        db.close();
      }
    } else {
      copyFileSync(entry.src, dst);
    }
  }

  const storeDb = join(targetDir, STORE_DIR, STORE_DB);
  if (plan.report.rows.runs !== undefined) {
    const from = `users/${pair.from}/`;
    const db = new Database(storeDb);
    try {
      db.prepare(
        "UPDATE runs SET workflow_path = ? || substr(workflow_path, ?) WHERE substr(workflow_path, 1, ?) = ?",
      ).run(`users/${pair.to}/`, from.length + 1, from.length, from);
    } finally {
      db.close();
    }
  }
  const rewritten = new Set(plan.report.refs.map((ref) => ref.file));
  for (const entry of items) {
    if (!rewritten.has(projectPathOf(project, join(targetDir, entry.dst)))) continue;
    const dst = join(targetDir, entry.dst);
    const raw = parseJson(readFileSync(dst, "utf8"));
    if (raw === undefined) continue;
    rewriteRefs(raw, plan, entry);
    writeFileSync(dst, serializeArtifact(raw));
  }

  return verify(plan);
}

function verify({ targetDir, items, report }: PairPlan): string[] {
  const problems: string[] = [];
  const copied = listFiles(targetDir, () => false).length;
  if (copied !== items.length) problems.push(`expected ${items.length} files, found ${copied}`);
  for (const entry of items) {
    if (!entry.dst.endsWith(".db")) continue;
    const db = openExisting(join(targetDir, entry.dst));
    try {
      const check = db.pragma("integrity_check", { simple: true });
      if (check !== "ok") problems.push(`${entry.dst}: integrity_check: ${String(check)}`);
      const expected =
        entry.dst === `${STORE_DIR}/${STORE_DB}` ? report.rows : rowCountsAt(entry.src);
      const actual = rowCounts(db);
      for (const [table, n] of Object.entries(expected)) {
        if (actual[table] !== n) {
          problems.push(
            `${entry.dst}: table ${table} has ${actual[table] ?? 0} rows, expected ${n}`,
          );
        }
      }
    } finally {
      db.close();
    }
  }
  return problems;
}

function moveCreatorRows(project: string, { from, to }: RemapPair): void {
  withCreatorTable(
    project,
    (db) =>
      db.prepare("UPDATE shared_creators SET creator = ? WHERE creator = ?").run(to, from).changes,
  );
}

function removeSource({ pair, authoredDir, storeDir, items }: PairPlan): void {
  rmSync(authoredDir, { recursive: true, force: true });
  if (pair.from !== DEFAULT_USER_ID) return;
  // `local`'s store shares the project `.path` with host files, so only what was copied goes.
  const tops = new Set(
    items
      .filter((entry) => entry.dst.startsWith(`${STORE_DIR}/`))
      .map((entry) => entry.dst.split("/")[1] as string),
  );
  for (const top of tops) rmSync(join(storeDir, top), { recursive: true, force: true });
  for (const side of ["-wal", "-shm", "-journal"]) {
    rmSync(join(storeDir, `${STORE_DB}${side}`), { force: true });
  }
}

/**
 * Rewrites, in place, each `workflow` ref of `raw` that reaches into the old user folder by name, so
 * it reaches the same file in the new one. A relative ref inside the folder moves with it unchanged.
 */
function rewriteRefs(raw: unknown, plan: PairPlan, entry: CopyItem): RefRewrite[] {
  const body = (raw as { body?: unknown }).body;
  if (!Array.isArray(body)) return [];
  const srcDir = dirname(entry.src);
  const dstFile = join(plan.targetDir, entry.dst);
  const project = dirname(dirname(plan.targetDir));
  const rewrites: RefRewrite[] = [];
  for (const node of walkNodes(body as WorkflowNode[])) {
    if (node.type !== "workflow" || typeof node.ref !== "string") continue;
    const target = resolve(srcDir, node.ref);
    const rel = relative(plan.authoredDir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const ref = toPosix(relative(dirname(dstFile), join(plan.targetDir, rel)));
    if (ref === node.ref) continue;
    rewrites.push({ file: projectPathOf(project, dstFile), from: node.ref, to: ref });
    node.ref = ref;
  }
  return rewrites;
}

/**
 * The pairs a production Clerk import implies: each user imported with `external_id` set to their
 * development id moves from that id to their production id.
 */
export function pairsFromClerkUsers(
  users: { id: string; externalId: string | null }[],
): RemapPair[] {
  return users.flatMap(({ id, externalId }) => (externalId ? [{ from: externalId, to: id }] : []));
}

/** Every user of the Clerk instance `secretKey` names, paged through the Backend API. */
export async function listClerkUsers(
  secretKey: string,
): Promise<{ id: string; externalId: string | null }[]> {
  const clerk = createClerkClient({ secretKey });
  const users: { id: string; externalId: string | null }[] = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const page = await clerk.users.getUserList({ limit, offset });
    users.push(...page.data.map((user) => ({ id: user.id, externalId: user.externalId })));
    if (page.data.length < limit) return users;
  }
}

/** Runs `use` on host.db's creator table; 0 when there is none. */
function withCreatorTable(project: string, use: (db: Database.Database) => number): number {
  const file = join(pathDir(project), "host.db");
  if (!existsSync(file)) return 0;
  const db = openExisting(file);
  try {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shared_creators'")
      .get();
    return table === undefined ? 0 : use(db);
  } finally {
    db.close();
  }
}

/** A read-write handle even for reads: a read-only one leaves a WAL database's `-wal` and `-shm`
 * files behind, and a dry run must change nothing. */
function openExisting(file: string): Database.Database {
  return new Database(file, { fileMustExist: true });
}

function rowCounts(db: Database.Database): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
    ]),
  );
}

function rowCountsAt(file: string): Record<string, number> {
  const db = openExisting(file);
  try {
    return rowCounts(db);
  } finally {
    db.close();
  }
}

/** Regular files under `root` as `/`-separated relative paths, without SQLite side files, edit
 * leases, symlinks, or what `skip` names; `[]` when `root` is absent. */
function listFiles(root: string, skip: (parts: string[]) => boolean): string[] {
  const found: string[] = [];
  const walk = (parts: string[]): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, ...parts), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = [...parts, entry.name];
      if (skip(child)) continue;
      if (entry.isDirectory()) walk(child);
      else if (
        entry.isFile() &&
        !SQLITE_SIDE_FILE.test(entry.name) &&
        !EDIT_LEASE.test(entry.name)
      ) {
        found.push(child.join("/"));
      }
    }
  };
  walk([]);
  return found.sort();
}

function item(root: string, rel: string, dst: string): CopyItem {
  const src = join(root, rel);
  return { src, dst, size: statSync(src).size };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function projectPathOf(project: string, abs: string): string {
  return toPosix(relative(project, abs));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
