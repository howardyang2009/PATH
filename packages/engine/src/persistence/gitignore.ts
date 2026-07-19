import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `.path/` is gitignored by default (mvp spec §6). A nested `.gitignore` self-scopes the whole
 * directory without touching the project's own `.gitignore` file. Written once — an operator's
 * customization (or a plain empty file marking "handled elsewhere") is never overwritten.
 */
export function ensurePathDirGitignore(pathDir: string): void {
  mkdirSync(pathDir, { recursive: true });
  const gitignorePath = join(pathDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "*\n", "utf8");
  }
}
