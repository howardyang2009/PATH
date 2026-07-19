import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePathDirGitignore } from "../../src/persistence/gitignore.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-gitignore-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensurePathDirGitignore", () => {
  it("creates the .path/ directory and a self-scoping .gitignore inside it", () => {
    const pathDir = join(dir, ".path");
    ensurePathDirGitignore(pathDir);
    expect(readFileSync(join(pathDir, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("does not overwrite an existing .gitignore the operator may have customized", () => {
    const pathDir = join(dir, ".path");
    ensurePathDirGitignore(pathDir);
    writeFileSync(join(pathDir, ".gitignore"), "custom\n", "utf8");

    ensurePathDirGitignore(pathDir);
    expect(readFileSync(join(pathDir, ".gitignore"), "utf8")).toBe("custom\n");
  });
});
