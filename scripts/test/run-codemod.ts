import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export interface CodemodResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a codemod as the operator would, in a child process.
 *
 * `tsx` is invoked by its binary rather than through `pnpm tsx` so the run works from any `cwd` —
 * the discovery test's `cwd` is a temp dir outside any pnpm project, where `pnpm` would fail before
 * the codemod ever started. Everything else about the invocation is the documented CLI shape.
 */
export function runCodemod(args: string[], cwd: string, script = "migrate-workflow-format-v2.ts"): CodemodResult {
  const result = spawnSync(join(repoRoot, "node_modules/.bin/tsx"), [join(repoRoot, "scripts", script), ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}
