import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathDir } from "@path/engine";
import { DEFAULT_USER_ID, USERS_DIR } from "./authored-layout.js";

// Where a project's per-user data and the Server's own files live on disk, as the authored layout
// says where authored files live. Each user has a folder under `users/`, and the host-level files
// sit in the project `.path`, which `local`'s store shares.

/** The host-level entries in the project `.path`. They belong to the Server, never to a user's
 * store, so a tool that moves `local`'s store leaves every one of them behind. */
export const HOST_FILES = {
  /** The creator table and VM-time usage. */
  db: "host.db",
  /** The per-user limit overrides. */
  limits: "limits.json",
  /** The pid of the Server holding the project open. */
  pid: "server.pid",
  /** Shared items an operator took down. */
  quarantine: "quarantine",
  removalLog: "remove-shared.log",
} as const;

/** The path of one host-level entry of `projectDir`. */
export function hostFile(projectDir: string, name: keyof typeof HOST_FILES): string {
  return join(pathDir(projectDir), HOST_FILES[name]);
}

/** The folder of `userId`: their authored roots and, for every user but `local`, their store. */
export function userDir(projectDir: string, userId: string): string {
  return join(projectDir, USERS_DIR, userId);
}

/** The directory `userId`'s store opens at: `local`'s is the project's own, every other user's
 * is their folder. */
export function storeDirOf(projectDir: string, userId: string): string {
  return userId === DEFAULT_USER_ID ? projectDir : userDir(projectDir, userId);
}

/** The user ids with a folder under `users/`. */
export function userIds(projectDir: string): string[] {
  const dir = join(projectDir, USERS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
