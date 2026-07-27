import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `@path/client-core` runs in a browser. Nothing mechanical enforces that — the repo has no linter
 * and no bundler step for this package — so the claim in its docblock ("No React, no DOM") was
 * upheld by discipline alone, while its `package.json` declared a runtime dependency on
 * `@path/engine`: SQLite (native), `node:child_process`, `node:fs`, and the Agent SDK. Every import
 * across that edge was `import type`, for exactly two names, both of which are domain vocabulary
 * that now lives in `@path/schema` (#66).
 *
 * These are the tests that make the boundary real rather than asserted.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const BANNED = ["@path/engine", "better-sqlite3", "node:fs", "node:child_process", "node:path", "node:os"];

describe("client-core stays browser-safe", () => {
  it("declares no dependency that cannot run in a browser", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@path/schema"]);
  });

  it("imports nothing from @path/engine or the Node standard library", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(packageRoot, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const banned of BANNED) {
        if (source.includes(`"${banned}"`)) offenders.push(`${file.slice(packageRoot.length + 1)} → ${banned}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
