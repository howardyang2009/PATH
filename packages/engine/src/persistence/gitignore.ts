import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `.path/` is gitignored by default via a nested `.gitignore` (mvp spec §6); written once, never overwritten. */
export function ensurePathDirGitignore(pathDir: string): void {
  mkdirSync(pathDir, { recursive: true });
  const gitignorePath = join(pathDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "*\n", "utf8");
  }
}
