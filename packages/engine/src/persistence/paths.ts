import { join } from "node:path";

/** `.path/` lives directly beside the project's workflow files, like `.git` (mvp spec §6). */
export function pathDir(projectDir: string): string {
  return join(projectDir, ".path");
}

export function dbFilePath(projectDir: string): string {
  return join(pathDir(projectDir), "path.db");
}

/** The engine-settings file, beside `path.db`. */
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

/** One subdirectory per run, keyed by run id; the root run's blobs sit at `runBlobDir(dir, root, root)`. */
export function runBlobDir(projectDir: string, rootRunId: string, runId: string): string {
  return join(rootRunTreeDir(projectDir, rootRunId), runId);
}

// The blobs a run's directory holds, spelled once so the write side and the archive cannot disagree.
export const RUN_BLOB_FILE = {
  input: "input.json",
  output: "output.json",
  context: "context.json",
  stderr: "stderr.txt",
} as const;

// A blob ref stored in a run row, relative to `.path/` (mvp spec §6). Always forward-slash-joined, unlike
// the filesystem-path helpers: it is a stored string read back on any OS, never used directly for I/O.
export function blobRef(rootRunId: string, runId: string, filename: string): string {
  return ["runs", rootRunId, runId, filename].join("/");
}
