import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openProject } from "@path/engine";
import Database from "better-sqlite3";
import { z } from "zod";
import { startPathServer } from "./create-server.js";

// A backup snapshot (docs/spec/path-website.md §9): `<out>/project/` mirrors the parts of the
// project that hold data, and `<out>/backup.json` lists its databases. The master key lives in the
// environment, never under the project, so no snapshot holds it.

export const MANIFEST_FILE = "backup.json";
const PROJECT_SUBDIR = "project";
const ROOTS = [".path", "users", "shared"];
const SQLITE_SIDE_FILE = /-(wal|shm|journal)$/;

const BackupManifestSchema = z
  .object({
    version: z.literal(1),
    created_at: z.string(),
    databases: z.array(z.string()),
  })
  .strict();

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export type TakeBackupResult =
  | { success: true; manifest: BackupManifest }
  | { success: false; error: string };

/** Project-relative paths of every regular file under the data roots, split into SQLite dbs and the
 * rest; SQLite side files are left out, since the online backup already folds them in. */
function dataFiles(projectDir: string): { databases: string[]; files: string[] } {
  const databases: string[] = [];
  const files: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (!entry.isFile() || SQLITE_SIDE_FILE.test(entry.name)) continue;
      else if (entry.name.endsWith(".db")) databases.push(child);
      else files.push(child);
    }
  };
  for (const root of ROOTS) walk(root);
  return { databases, files };
}

/**
 * Snapshots `projectDir` into the empty or absent `outDir`. Each db is copied with the SQLite
 * online backup API, so a Server may keep writing. Files are listed only after the dbs are copied,
 * so a blob a copied row names is there; the manifest is written last and marks a whole snapshot.
 */
export async function takeBackup({
  projectDir,
  outDir,
  now = new Date(),
}: {
  projectDir: string;
  outDir: string;
  now?: Date;
}): Promise<TakeBackupResult> {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    return { success: false, error: `${outDir} is not empty` };
  }
  const target = join(outDir, PROJECT_SUBDIR);
  mkdirSync(target, { recursive: true });
  const { databases } = dataFiles(projectDir);
  for (const rel of databases) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    const db = new Database(join(projectDir, rel), { readonly: true, fileMustExist: true });
    try {
      await db.backup(join(target, rel));
    } finally {
      db.close();
    }
  }
  for (const rel of dataFiles(projectDir).files) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    try {
      copyFileSync(join(projectDir, rel), join(target, rel), constants.COPYFILE_FICLONE);
    } catch (err) {
      // A run deleted or a staging directory cleared since the listing.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const manifest: BackupManifest = { version: 1, created_at: now.toISOString(), databases };
  writeFileSync(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return { success: true, manifest };
}

export type VerifyBackupResult =
  | { success: true; databases: number; stores: number }
  | { success: false; error: string };

/** Why the db at `file` is damaged: `integrity_check` fails, or a run row names a blob the snapshot
 * lacks (refs are relative to the db's `.path/`). `undefined` when it is whole. */
function integrityProblem(file: string): string | undefined {
  if (!existsSync(file)) return "missing";
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = db.pragma("integrity_check") as { integrity_check: string }[];
      const messages = rows.map((row) => row.integrity_check);
      if (messages.join("; ") !== "ok") return messages.slice(0, 5).join("; ");
      const hasRuns = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
        .get();
      if (hasRuns === undefined) return undefined;
      const refs = db
        .prepare<[], { ref: string }>(
          "SELECT input_ref AS ref FROM runs WHERE input_ref IS NOT NULL UNION SELECT output_ref FROM runs WHERE output_ref IS NOT NULL",
        )
        .all()
        .map((row) => row.ref);
      const lost = refs.filter((ref) => !existsSync(join(dirname(file), ref)));
      return lost.length === 0 ? undefined : `blob missing: ${lost.slice(0, 5).join(", ")}`;
    } finally {
      db.close();
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Checks the snapshot at `snapshotDir` on a throwaway copy, so the snapshot never changes: every db
 * the manifest lists passes `PRAGMA integrity_check` and has every blob its runs name, every user's
 * store opens, and a local-mode
 * Server boots on the copy and lists its runs.
 */
export async function verifyBackup({
  snapshotDir,
}: {
  snapshotDir: string;
}): Promise<VerifyBackupResult> {
  let manifest: BackupManifest;
  try {
    manifest = BackupManifestSchema.parse(
      JSON.parse(readFileSync(join(snapshotDir, MANIFEST_FILE), "utf8")),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { success: false, error: `no valid ${MANIFEST_FILE} in ${snapshotDir}: ${reason}` };
  }

  const workDir = mkdtempSync(join(tmpdir(), "path-backup-verify-"));
  const copy = join(workDir, PROJECT_SUBDIR);
  const problems: string[] = [];
  let stores = 0;
  try {
    cpSync(join(snapshotDir, PROJECT_SUBDIR), copy, { recursive: true });
    for (const rel of manifest.databases) {
      const problem = integrityProblem(join(copy, rel));
      if (problem !== undefined) problems.push(`${rel}: ${problem}`);
    }
    if (problems.length > 0) return { success: false, error: problems.join("\n") };

    const usersDir = join(copy, "users");
    const userIds = existsSync(usersDir) ? readdirSync(usersDir) : [];
    for (const userId of userIds) {
      if (!existsSync(join(usersDir, userId, ".path", "path.db"))) continue;
      const opened = openProject(join(usersDir, userId));
      if (opened.success) {
        opened.project.close();
        stores += 1;
      } else {
        problems.push(`users/${userId}: ${opened.error}`);
      }
    }

    try {
      const handle = await startPathServer(
        copy,
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { mode: "local", publishableKey: null },
      );
      try {
        const res = await fetch(`${handle.url}/v0/runs`);
        if (res.status !== 200) problems.push(`Server answered GET /v0/runs with ${res.status}`);
      } finally {
        await handle.close();
      }
    } catch (err) {
      problems.push(`Server did not boot: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  if (problems.length > 0) return { success: false, error: problems.join("\n") };
  return { success: true, databases: manifest.databases.length, stores };
}

/** The snapshot directory under `dir`: `restic restore` recreates the path it was taken from, so
 * the snapshot sits some levels down. `undefined` when there is none. */
export function findSnapshot(dir: string): string | undefined {
  if (existsSync(join(dir, MANIFEST_FILE)) && existsSync(join(dir, PROJECT_SUBDIR))) return dir;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findSnapshot(join(dir, entry.name));
    if (found !== undefined) return found;
  }
  return undefined;
}
