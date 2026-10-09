import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostFile, storeDirOf, userDir, userIds } from "../src/host-layout.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-host-layout-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("host layout", () => {
  it("lists the user folders under users/, and none for a project without one", () => {
    expect(userIds(projectDir)).toEqual([]);
    mkdirSync(join(projectDir, "users", "user_a"), { recursive: true });
    mkdirSync(join(projectDir, "users", "local"), { recursive: true });
    writeFileSync(join(projectDir, "users", "stray.txt"), "");

    expect(userIds(projectDir).sort()).toEqual(["local", "user_a"]);
  });

  it("opens local's store on the project and every other user's in their folder", () => {
    expect(storeDirOf(projectDir, "local")).toBe(projectDir);
    expect(storeDirOf(projectDir, "user_a")).toBe(userDir(projectDir, "user_a"));
    expect(userDir(projectDir, "user_a")).toBe(join(projectDir, "users", "user_a"));
  });

  it("keeps the host-level files in the project .path", () => {
    expect(hostFile(projectDir, "db")).toBe(join(projectDir, ".path", "host.db"));
    expect(hostFile(projectDir, "limits")).toBe(join(projectDir, ".path", "limits.json"));
  });
});
