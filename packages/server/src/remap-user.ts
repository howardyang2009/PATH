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
import { type CreatorTable, HOST_DB_FILE, openCreatorTable } from "./creator-table.js";
import { QUARANTINE_DIR, REMOVAL_LOG_FILE } from "./remove-shared.js";
import { LIMITS_FILE } from "./request-limits.js";
import { SANDBOX_DIR } from "./sandbox/sandboxed-runs.js";
import { runningServerPid, SERVER_PID_FILE } from "./server-pid.js";

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
  /** The source holds nothing, and `skipEmpty` let the pair pass without a move. */
  nothingToMove: boolean;
  /** Symlinks and other entries that are not regular files, which the copy leaves behind. */
  notCopied: string[];
  /** Refs in `shared/` workflows that reach the old folder; they are listed, never rewritten. */
  sharedRefs: { file: string; ref: string }[];
  conflicts: string[];
}

/** A Clerk user's id and the `external_id` an import set on them. */
export interface ClerkUserIds {
  id: string;
  externalId: string | null;
}

export type RemapUserResult =
  | { success: true; reports: RemapReport[] }
  | { success: false; error: string; reports: RemapReport[] };

export interface RemapUserOptions {
  projectDir: string;
  pairs: RemapPair[];
  dryRun?: boolean;
  deleteSource?: boolean;
  /** Pass a pair whose source holds nothing instead of refusing it: a Clerk import names users
   * who never used the development instance. */
  skipEmpty?: boolean;
}

/** A folder-safe id other than `local`, which only the source of a remap may be. */
const USER_ID = /^[A-Za-z0-9_-]+$/;
// Host-level entries in the project `.path`, which stay when `local`'s store moves; the VM staging
// in `SANDBOX_DIR` is reaped at boot.
const HOST_ONLY = new Set([
  HOST_DB_FILE,
  LIMITS_FILE,
  QUARANTINE_DIR,
  REMOVAL_LOG_FILE,
  SERVER_PID_FILE,
  SANDBOX_DIR,
]);
const SQLITE_SIDE_SUFFIXES = ["-wal", "-shm", "-journal"];
const EDIT_LEASE = /\.editing$/;
const STORE_DIR = ".path";
const STORE_DB = "path.db";
const STORE_DB_DST = `${STORE_DIR}/${STORE_DB}`;

interface CopyItem {
  src: string;
  /** Relative to the target folder, `/`-separated. */
  dst: string;
  size: number;
  /** An authored file, a store file, or a store database, which is copied with `VACUUM INTO`. */
  kind: "authored" | "store" | "database";
}

interface PairPlan {
  project: string;
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
  skipEmpty = false,
}: RemapUserOptions): RemapUserResult {
  const project = resolve(projectDir);
  const pid = runningServerPid(project);
  if (pid !== undefined && !dryRun) {
    return {
      success: false,
      error: `the Server is running (pid ${pid}); stop it before remap-user`,
      reports: [],
    };
  }

  const plans = pairs.map((pair) => planPair(project, pair, pairs, { deleteSource, skipEmpty }));
  const reports = plans.map((plan) => plan.report);
  if (dryRun) {
    if (pid !== undefined) {
      for (const report of reports) {
        report.conflicts.unshift(`the Server is running (pid ${pid}); stop it first`);
      }
    }
    return { success: true, reports };
  }
  const conflicts = plans.flatMap(({ pair, report }) =>
    report.conflicts.map((conflict) => `${pair.from} -> ${pair.to}: ${conflict}`),
  );
  if (conflicts.length > 0) return { success: false, error: conflicts.join("\n"), reports };

  // Every pair is copied and verified before any creator row moves or source goes, so a failure
  // removes the copies and leaves the project as it was.
  const moving = plans.filter((plan) => !plan.report.nothingToMove);
  for (const [i, plan] of moving.entries()) {
    let problems: string[];
    try {
      problems = applyPlan(plan);
    } catch (err) {
      problems = [err instanceof Error ? err.message : String(err)];
    }
    if (problems.length > 0) {
      for (const copied of moving.slice(0, i + 1)) {
        rmSync(copied.targetDir, { recursive: true, force: true });
      }
      const head = `${plan.pair.from} -> ${plan.pair.to}: the copy failed; nothing was changed`;
      return { success: false, error: [head, ...problems].join("\n"), reports };
    }
  }
  for (const plan of moving) {
    withCreators(project, (creators) => creators.reassign(plan.pair.from, plan.pair.to));
    if (deleteSource) removeSource(plan);
  }
  return { success: true, reports };
}

function planPair(
  project: string,
  pair: RemapPair,
  all: RemapPair[],
  { deleteSource, skipEmpty }: { deleteSource: boolean; skipEmpty: boolean },
): PairPlan {
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
    nothingToMove: false,
    notCopied: [],
    sharedRefs: [],
    conflicts: [],
  };
  const plan: PairPlan = { project, pair, authoredDir, storeDir, targetDir, items: [], report };

  const badIds = [from, to].filter(
    (id, i) => !USER_ID.test(id) || (i === 1 && id === DEFAULT_USER_ID),
  );
  for (const id of badIds) report.conflicts.push(`"${id}" is not a valid user id`);
  if (badIds.length > 0) return plan;
  if (from === to) report.conflicts.push("the source and target are the same id");
  if (all.filter((other) => other.to === to || other.from === to).length > 1) {
    report.conflicts.push(`users/${to}/ is named more than once`);
  }
  if (all.filter((other) => other.from === from).length > 1) {
    report.conflicts.push(`users/${from}/ is named more than once`);
  }
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    report.conflicts.push(`users/${to}/ is not empty`);
  }

  const authored = listFiles(authoredDir, (parts) => parts[0] === STORE_DIR);
  const store = listFiles(
    storeDir,
    (parts) => parts.length === 1 && HOST_ONLY.has(parts[0] as string),
  );
  plan.items = [
    ...authored.files.map((rel) => item(authoredDir, rel, rel, "authored")),
    ...store.files.map((rel) =>
      item(storeDir, rel, `${STORE_DIR}/${rel}`, rel.endsWith(".db") ? "database" : "store"),
    ),
  ];
  report.notCopied = [
    ...authored.others.map((rel) => projectPath(project, join(authoredDir, rel))),
    ...store.others.map((rel) => projectPath(project, join(storeDir, rel))),
  ];
  if (deleteSource && report.notCopied.length > 0) {
    report.conflicts.push(
      `${report.notCopied.length} entries are not regular files and would be lost with the source: ${report.notCopied.join(", ")}`,
    );
  }
  if (plan.items.length === 0) {
    if (skipEmpty) report.nothingToMove = true;
    else report.conflicts.push(`users/${from}/ and its store hold nothing to move`);
    return plan;
  }
  report.files = plan.items.length;
  report.bytes = plan.items.reduce((sum, entry) => sum + entry.size, 0);

  const storeDb = join(storeDir, STORE_DB);
  if (existsSync(storeDb)) {
    withDb(storeDb, (db) => {
      report.rows = rowCounts(db);
      if (report.rows.runs === undefined) return;
      const prefix = `users/${from}/`;
      report.workflowPaths = (
        db
          .prepare("SELECT COUNT(*) AS n FROM runs WHERE substr(workflow_path, 1, ?) = ?")
          .get(prefix.length, prefix) as { n: number }
      ).n;
    });
  }
  for (const entry of plan.items) {
    if (entry.kind !== "authored" || !entry.dst.endsWith(".workflow.json")) continue;
    const raw = parseJson(readFileSync(entry.src, "utf8"));
    if (raw !== undefined) report.refs.push(...rewriteRefs(raw, plan, entry));
  }
  const sharedDir = join(project, "shared");
  for (const rel of listFiles(sharedDir, () => false).files) {
    if (!rel.endsWith(".workflow.json")) continue;
    const file = join(sharedDir, rel);
    const raw = parseJson(readFileSync(file, "utf8"));
    for (const ref of raw === undefined ? [] : workflowRefs(raw)) {
      if (within(authoredDir, resolve(dirname(file), ref.ref))) {
        report.sharedRefs.push({ file: projectPath(project, file), ref: ref.ref });
      }
    }
  }
  report.creatorRows = withCreators(project, (creators) => creators.countBy(from));
  return plan;
}

/** Copies, rewrites and verifies one pair; returns what verification found wrong. */
function applyPlan(plan: PairPlan): string[] {
  const { project, pair, targetDir, items } = plan;
  for (const entry of items) {
    const dst = join(targetDir, entry.dst);
    mkdirSync(dirname(dst), { recursive: true });
    if (entry.kind === "database") {
      // VACUUM INTO folds any WAL content into a self-contained copy.
      withDb(entry.src, (db) => db.prepare("VACUUM INTO ?").run(dst));
    } else {
      copyFileSync(entry.src, dst);
    }
  }

  if (plan.report.rows.runs !== undefined) {
    const from = `users/${pair.from}/`;
    withDb(join(targetDir, STORE_DB_DST), (db) =>
      db
        .prepare(
          "UPDATE runs SET workflow_path = ? || substr(workflow_path, ?) WHERE substr(workflow_path, 1, ?) = ?",
        )
        .run(`users/${pair.to}/`, from.length + 1, from.length, from),
    );
  }
  const rewritten = new Set(plan.report.refs.map((ref) => ref.file));
  for (const entry of items) {
    if (!rewritten.has(projectPath(project, join(targetDir, entry.dst)))) continue;
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
  const copied = listFiles(targetDir, () => false).files.length;
  if (copied !== items.length) problems.push(`expected ${items.length} files, found ${copied}`);
  for (const entry of items) {
    if (entry.kind !== "database") continue;
    const expected = entry.dst === STORE_DB_DST ? report.rows : withDb(entry.src, rowCounts);
    withDb(join(targetDir, entry.dst), (db) => {
      const check = db.pragma("integrity_check", { simple: true });
      if (check !== "ok") problems.push(`${entry.dst}: integrity_check: ${String(check)}`);
      const actual = rowCounts(db);
      for (const [table, n] of Object.entries(expected)) {
        if (actual[table] !== n) {
          problems.push(
            `${entry.dst}: table ${table} has ${actual[table] ?? 0} rows, expected ${n}`,
          );
        }
      }
    });
  }
  return problems;
}

function removeSource({ pair, authoredDir, storeDir, items }: PairPlan): void {
  rmSync(authoredDir, { recursive: true, force: true });
  if (pair.from !== DEFAULT_USER_ID) return;
  // `local`'s store shares the project `.path` with host files, so only what was copied goes.
  const tops = new Set(
    items
      .filter((entry) => entry.kind !== "authored")
      .map((entry) => entry.dst.split("/")[1] as string)
      .filter((top) => top !== ".gitignore"),
  );
  for (const top of tops) rmSync(join(storeDir, top), { recursive: true, force: true });
  for (const side of SQLITE_SIDE_SUFFIXES) {
    rmSync(join(storeDir, `${STORE_DB}${side}`), { force: true });
  }
}

/**
 * Rewrites, in place, each `workflow` ref of `raw` that reaches into the old user folder by name, so
 * it reaches the same file in the new one. A relative ref inside the folder moves with it unchanged.
 */
function rewriteRefs(raw: unknown, plan: PairPlan, entry: CopyItem): RefRewrite[] {
  const srcDir = dirname(entry.src);
  const dstFile = join(plan.targetDir, entry.dst);
  const rewrites: RefRewrite[] = [];
  for (const node of workflowRefs(raw)) {
    const target = resolve(srcDir, node.ref);
    if (!within(plan.authoredDir, target)) continue;
    const rel = relative(plan.authoredDir, target);
    const ref = toPosix(relative(dirname(dstFile), join(plan.targetDir, rel)));
    if (ref === node.ref) continue;
    rewrites.push({ file: projectPath(plan.project, dstFile), from: node.ref, to: ref });
    node.ref = ref;
  }
  return rewrites;
}

/** The `workflow` nodes of a parsed workflow file, whose `ref` a caller may set in place. */
function workflowRefs(raw: unknown): { ref: string }[] {
  const body = (raw as { body?: unknown } | null)?.body;
  if (!Array.isArray(body)) return [];
  return [...walkNodes(body as WorkflowNode[])].filter(
    (node): node is WorkflowNode & { type: "workflow"; ref: string } =>
      node.type === "workflow" && typeof node.ref === "string",
  );
}

function within(dir: string, abs: string): boolean {
  const rel = relative(dir, abs);
  return !(rel.startsWith("..") || isAbsolute(rel));
}

/**
 * The pairs a production Clerk import implies: each user imported with `external_id` set to their
 * development id moves from that id to their production id.
 */
export function pairsFromClerkUsers(users: ClerkUserIds[]): RemapPair[] {
  return users.flatMap(({ id, externalId }) => (externalId ? [{ from: externalId, to: id }] : []));
}

/** Every user of the Clerk instance `secretKey` names, paged through the Backend API. */
export async function listClerkUsers(secretKey: string): Promise<ClerkUserIds[]> {
  const clerk = createClerkClient({ secretKey });
  const users: ClerkUserIds[] = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const page = await clerk.users.getUserList({ limit, offset });
    users.push(...page.data.map((user) => ({ id: user.id, externalId: user.externalId })));
    if (page.data.length < limit) return users;
  }
}

/** Runs `use` on the creator table; 0 when the project has no host.db yet. */
function withCreators(project: string, use: (creators: CreatorTable) => number): number {
  const file = join(pathDir(project), HOST_DB_FILE);
  if (!existsSync(file)) return 0;
  const creators = openCreatorTable(file);
  try {
    return use(creators);
  } finally {
    creators.close();
  }
}

/** Runs `use` on an existing database. The handle is read-write even for reads: a read-only one
 * leaves a WAL database's `-wal` and `-shm` files behind, and a dry run must change nothing. */
function withDb<T>(file: string, use: (db: Database.Database) => T): T {
  const db = new Database(file, { fileMustExist: true });
  try {
    return use(db);
  } finally {
    db.close();
  }
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

/** Regular files under `root` as `/`-separated relative paths, without SQLite side files, edit
 * leases or what `skip` names, plus the symlinks and other entries that are not regular files. */
function listFiles(
  root: string,
  skip: (parts: string[]) => boolean,
): { files: string[]; others: string[] } {
  const found: string[] = [];
  const others: string[] = [];
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
        !SQLITE_SIDE_SUFFIXES.some((suffix) => entry.name.endsWith(`.db${suffix}`)) &&
        !EDIT_LEASE.test(entry.name)
      ) {
        found.push(child.join("/"));
      } else if (!entry.isFile()) {
        others.push(child.join("/"));
      }
    }
  };
  walk([]);
  return { files: found.sort(), others: others.sort() };
}

function item(root: string, rel: string, dst: string, kind: CopyItem["kind"]): CopyItem {
  const src = join(root, rel);
  return { src, dst, size: statSync(src).size, kind };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function projectPath(project: string, abs: string): string {
  return toPosix(relative(project, abs));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
