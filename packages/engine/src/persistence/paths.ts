import { join } from "node:path";

/** `.path/` lives directly beside the project's workflow files, like `.git` (mvp spec §6). */
export function pathDir(projectDir: string): string {
  return join(projectDir, ".path");
}

export function dbFilePath(projectDir: string): string {
  return join(pathDir(projectDir), "path.db");
}

/** The engine-settings file (ticket #27), beside `path.db`. */
export function engineSettingsFilePath(projectDir: string): string {
  return join(pathDir(projectDir), "settings.json");
}

export function runsDir(projectDir: string): string {
  return join(pathDir(projectDir), "runs");
}

/** One directory tree per root run, mirroring the run tree (mvp spec §6). */
export function rootRunTreeDir(projectDir: string, rootRunId: string): string {
  return join(runsDir(projectDir), rootRunId);
}

/**
 * One subdirectory per run in the tree, keyed by run id — the root run's own blobs live at
 * `runBlobDir(dir, rootRunId, rootRunId)` since its run id *is* the root run id.
 */
export function runBlobDir(projectDir: string, rootRunId: string, runId: string): string {
  return join(rootRunTreeDir(projectDir, rootRunId), runId);
}

/**
 * The blobs a run's directory holds, spelled once. The write side records them and the archive
 * reads them back, and a filename each side spells for itself is a filename they can disagree
 * about — the same class of defect as a ref and a directory built separately (#72).
 */
export const RUN_BLOB_FILE = {
  input: "input.json",
  output: "output.json",
  context: "context.json",
  stderr: "stderr.txt",
} as const;

/**
 * A blob ref stored in a run row, relative to `.path/` — keeps the db portable (mvp spec §6).
 * Always forward-slash-joined (unlike the filesystem-path helpers above, which use the host's
 * native separator): it's a stored string read back on any OS, not used directly for I/O.
 */
export function blobRef(rootRunId: string, runId: string, filename: string): string {
  return ["runs", rootRunId, runId, filename].join("/");
}
