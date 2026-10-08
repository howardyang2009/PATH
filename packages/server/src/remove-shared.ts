import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pathDir } from "@path/engine";
import { AUTHORED_SUFFIX, authoredLayout } from "./authored-layout.js";
import { HOST_DB_FILE, openCreatorTable, projectPathOf } from "./creator-table.js";
import { editLease } from "./edit-lease.js";

// The operator's takedown of an abusive shared item (spec path-website §9). It works on disk and on
// the creator table only, so it is safe while the Server runs: every door scans afresh, and a run
// of the removed workflow keeps its rows while Resume and Complete find no file and answer 404.

export const QUARANTINE_DIR = "quarantine";
export const REMOVAL_LOG_FILE = "remove-shared.log";
const QUARANTINE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RemoveSharedOptions {
  projectDir: string;
  /** The shared item, relative to `projectDir` or absolute. */
  path: string;
  reason: string;
  /** Delete at once instead of quarantining. */
  purge?: boolean;
  /** Also list files under `users/*` with the same content; they are never touched. */
  findCopies?: boolean;
  now?: Date;
}

export type RemoveSharedResult =
  | {
      success: true;
      projectPath: string;
      creator: string | undefined;
      action: "quarantine" | "purge";
      /** Where the file now sits, or `undefined` after a purge. */
      quarantinedTo: string | undefined;
      copies: string[];
      /** The quarantine day folders this call deleted as expired. */
      expired: string[];
    }
  | { success: false; error: string };

export function removeShared({
  projectDir,
  path,
  reason,
  purge = false,
  findCopies = false,
  now = new Date(),
}: RemoveSharedOptions): RemoveSharedResult {
  const layout = authoredLayout({ projectDir });
  const projectPath = projectPathOf(layout, path);
  const place = layout.classify(projectPath);
  if (place?.origin !== "shared" || !projectPath.endsWith(AUTHORED_SUFFIX[place.kind])) {
    return { success: false, error: `"${projectPath}" is not a shared item` };
  }
  const absPath = join(layout.projectDir, projectPath);
  if (!existsSync(absPath) || !statSync(absPath).isFile()) {
    return { success: false, error: `no file at "${projectPath}"` };
  }

  const stateDir = pathDir(layout.projectDir);
  const quarantineDir = join(stateDir, QUARANTINE_DIR);
  const expired = sweepQuarantine(quarantineDir, now);
  const copies = findCopies ? copiesOf(layout.projectDir, readFileSync(absPath)) : [];

  // The row goes first: while it stands, the creator's write door still accepts a save that would
  // put the file back.
  const creators = openCreatorTable(join(stateDir, HOST_DB_FILE));
  const creator = creators.creatorOf(projectPath, place.kind);
  creators.forget(projectPath, place.kind);
  creators.close();

  let quarantinedTo: string | undefined;
  if (purge) {
    rmSync(absPath);
  } else {
    quarantinedTo = freePath(join(quarantineDir, dayOf(now), projectPath));
    mkdirSync(dirname(quarantinedTo), { recursive: true });
    renameSync(absPath, quarantinedTo);
  }
  editLease(layout.projectDir, projectPath)?.remove();

  const action = purge ? "purge" : "quarantine";
  const entry = {
    time: now.toISOString(),
    path: projectPath,
    kind: place.kind,
    creator: creator ?? null,
    reason,
    action,
  };
  appendFileSync(join(stateDir, REMOVAL_LOG_FILE), `${JSON.stringify(entry)}\n`);

  return { success: true, projectPath, creator, action, quarantinedTo, copies, expired };
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `path`, or `path.1`, `path.2`, … when an earlier removal the same day already holds it. */
function freePath(path: string): string {
  let candidate = path;
  for (let n = 1; existsSync(candidate); n += 1) candidate = `${path}.${n}`;
  return candidate;
}

/** Delete each `YYYY-MM-DD` day folder whose every file has sat `QUARANTINE_DAYS` full days, so the
 * day's end counts; returns their names. */
function sweepQuarantine(quarantineDir: string, now: Date): string[] {
  if (!existsSync(quarantineDir)) return [];
  const expired = readdirSync(quarantineDir).filter((day) => {
    const time = Date.parse(`${day}T00:00:00Z`);
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(day) && now.getTime() - time >= (QUARANTINE_DAYS + 1) * DAY_MS
    );
  });
  for (const day of expired) rmSync(join(quarantineDir, day), { recursive: true, force: true });
  return expired.sort();
}

/** Project paths of the files under `users/` whose content hashes as `bytes` does. */
function copiesOf(projectDir: string, bytes: Buffer): string[] {
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const target = digest(bytes);
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && digest(readFileSync(abs)) === target) {
        found.push(relative(projectDir, abs).split(sep).join("/"));
      }
    }
  };
  walk(join(projectDir, "users"));
  return found.sort();
}
