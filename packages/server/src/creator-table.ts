import { mkdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import type {
  AuthoredKind,
  AuthoredLayout,
  AuthoredRefusal,
  AuthoredRoot,
} from "./authored-layout.js";

// The creator table (ADR 0088 §3): a host-level map from a shared item's project path and kind to
// the user who created it. Only that user writes or deletes the item; an item with no row is
// read-only for everyone. The file itself carries no creator, so a client cannot forge one.

export interface CreatorTable {
  /** The user who created the shared item, or `undefined` when no row records one. */
  creatorOf(projectPath: string, kind: AuthoredKind): string | undefined;
  /** Record `userId` as the item's creator, replacing any stale row. */
  stamp(projectPath: string, kind: AuthoredKind, userId: string): void;
  forget(projectPath: string, kind: AuthoredKind): void;
  /** How many shared items `userId` created. */
  countBy(userId: string): number;
  /** The project paths of the shared items `userId` created. */
  pathsBy(userId: string): string[];
  /** Move every row of `from` to `to`; returns how many moved. */
  reassign(from: string, to: string): number;
  close(): void;
}

/** The host-level database in the project `.path`: the creator table and VM-time usage. */
export const HOST_DB_FILE = "host.db";

export const SHARED_ITEM_READ_ONLY = "only the creator edits a shared item";

/** Opens (creating if absent) the creator table at `dbPath`; `":memory:"` keeps it in memory. */
export function openCreatorTable(dbPath: string): CreatorTable {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_creators (
      project_path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('workflow','template')),
      creator TEXT NOT NULL,
      PRIMARY KEY (project_path, kind)
    );
  `);
  const select = db.prepare<[string, string], { creator: string }>(
    "SELECT creator FROM shared_creators WHERE project_path = ? AND kind = ?",
  );
  const upsert = db.prepare<[string, string, string]>(
    "INSERT OR REPLACE INTO shared_creators (project_path, kind, creator) VALUES (?, ?, ?)",
  );
  const remove = db.prepare<[string, string]>(
    "DELETE FROM shared_creators WHERE project_path = ? AND kind = ?",
  );
  const count = db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM shared_creators WHERE creator = ?",
  );
  const paths = db.prepare<[string], { project_path: string }>(
    "SELECT project_path FROM shared_creators WHERE creator = ?",
  );
  const reassign = db.prepare<[string, string]>(
    "UPDATE shared_creators SET creator = ? WHERE creator = ?",
  );
  return {
    creatorOf: (projectPath, kind) => select.get(projectPath, kind)?.creator,
    stamp: (projectPath, kind, userId) => void upsert.run(projectPath, kind, userId),
    forget: (projectPath, kind) => void remove.run(projectPath, kind),
    countBy: (userId) => count.get(userId)?.n ?? 0,
    pathsBy: (userId) => paths.all(userId).map((row) => row.project_path),
    reassign: (from, to) => reassign.run(to, from).changes,
    close: () => db.close(),
  };
}

/** The table's key for a file: its `/`-separated path relative to the project directory. */
export function projectPathOf(layout: AuthoredLayout, path: string): string {
  return relative(layout.projectDir, resolve(layout.projectDir, path)).split(sep).join("/");
}

/** Whether the layout's user may change the item at `path`: anything but a shared item passes
 * here, and a shared item passes only for its recorded creator. */
export function sharedWriteRefusal(
  layout: AuthoredLayout,
  creators: CreatorTable,
  path: string,
  kind: AuthoredKind,
): AuthoredRefusal | undefined {
  if (layout.classify(path)?.origin !== "shared") return undefined;
  return creators.creatorOf(projectPathOf(layout, path), kind) === layout.userId
    ? undefined
    : { status: 403, message: SHARED_ITEM_READ_ONLY };
}

/** Whether the layout's user may not write the scanned file at `absPath` under `root`: a shipped
 * file never, a shared one unless they created it. */
export function readOnlyFor(
  layout: AuthoredLayout,
  creators: CreatorTable,
  { absPath, root }: { absPath: string; root: AuthoredRoot },
): boolean {
  if (!root.writable) return true;
  if (root.origin !== "shared") return false;
  return creators.creatorOf(projectPathOf(layout, absPath), root.kind) !== layout.userId;
}

/** Stamp the layout's user on every shared file that has no row yet. Local mode adopts the
 * existing `shared/` this way at boot, so it stays editable. */
export function adoptSharedItems(layout: AuthoredLayout, creators: CreatorTable): void {
  for (const kind of ["workflow", "template"] as const) {
    for (const { absPath, root } of layout.files(kind)) {
      if (root.origin !== "shared") continue;
      const projectPath = projectPathOf(layout, absPath);
      if (creators.creatorOf(projectPath, kind) === undefined) {
        creators.stamp(projectPath, kind, layout.userId);
      }
    }
  }
}
