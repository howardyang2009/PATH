import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathDir } from "@path/engine";

// A marker that a Server holds this project open, so an offline operator tool can refuse to run
// beside it. A crash leaves the file behind; its pid then names no live process.

function pidFile(projectDir: string): string {
  return join(pathDir(projectDir), "server.pid");
}

/** Records this process as the project's Server; the returned function removes the record if it
 * is still this process's. */
export function markServerRunning(projectDir: string): () => void {
  const file = pidFile(projectDir);
  writeFileSync(file, `${process.pid}\n`);
  return () => {
    if (readPid(file) === process.pid) rmSync(file, { force: true });
  };
}

/** The pid of the live Server holding the project open, or `undefined` when none does. */
export function runningServerPid(projectDir: string): number | undefined {
  const pid = readPid(pidFile(projectDir));
  if (pid === undefined) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM: the process lives but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}

function readPid(file: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}
