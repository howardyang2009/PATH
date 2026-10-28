import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authoredLayout } from "../src/authored-layout.js";
import { type CreatorTable, openCreatorTable } from "../src/creator-table.js";
import { DEFAULT_LIMITS } from "../src/request-limits.js";
import { type WriteAccess, writeAccess } from "../src/write-access.js";

const SHARED = "shared/workflow/a.workflow.json";
const CREATE = { ifMatch: undefined, rule: "create-or-overwrite" } as const;

let projectDir: string;
let creators: CreatorTable;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-write-access-"));
  creators = openCreatorTable(":memory:");
});

afterEach(() => {
  creators.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function write(relPath: string): void {
  mkdirSync(join(projectDir, relPath, ".."), { recursive: true });
  writeFileSync(join(projectDir, relPath), "{}");
}

function accessOf(userId: string, limits = DEFAULT_LIMITS): WriteAccess {
  return writeAccess(authoredLayout({ projectDir, userId, hosted: true }), creators, limits);
}

describe("write access", () => {
  it("lets only the creator change an existing shared workflow", () => {
    write(SHARED);
    creators.stamp(SHARED, "workflow", "user_alice");

    expect(accessOf("user_alice").workflow(SHARED)).toMatchObject({ ok: true, exists: true });
    expect(accessOf("user_bob").workflow(`./${SHARED}`)).toMatchObject({ ok: false, status: 403 });
  });

  it("keeps a shared workflow with no creator row read-only for everyone", () => {
    write(SHARED);
    expect(accessOf("user_alice").workflow(SHARED)).toMatchObject({ ok: false, status: 403 });
  });

  it("passes a missing shared workflow, and its write checks the shared-item limit", () => {
    const access = accessOf("user_bob", { ...DEFAULT_LIMITS, maxSharedItems: 1 });
    expect(access.workflow(SHARED)).toMatchObject({ ok: true, exists: false });

    creators.stamp("shared/workflow/other.workflow.json", "workflow", "user_bob");
    expect(access.write(join(projectDir, SHARED), "workflow", {}, CREATE)).toEqual({
      ok: false,
      status: 403,
      code: "authored.shared-limit",
      params: { max: 1 },
    });
    const own = join(projectDir, "users/user_bob/workflow/mine.workflow.json");
    expect(access.write(own, "workflow", {}, CREATE)).toMatchObject({ ok: true, created: true });
  });

  it("writes a created shared file, stamps its creator, and refuses a stale overwrite", () => {
    const access = accessOf("user_alice");
    const path = join(projectDir, SHARED);
    const written = access.write(path, "workflow", { a: 1 }, CREATE);
    expect(written).toMatchObject({ ok: true, created: true });
    expect(creators.creatorOf(SHARED, "workflow")).toBe("user_alice");
    expect(access.write(path, "workflow", {}, { ifMatch: '"stale"', rule: "overwrite" })).toEqual({
      ok: false,
      status: 412,
      code: "file.precondition.changed",
    });
  });

  it("answers 404 for another user's path, and refuses a template path", () => {
    write("users/user_alice/workflow/x.workflow.json");
    expect(
      accessOf("user_bob").workflow("users/user_alice/workflow/x.workflow.json"),
    ).toMatchObject({ ok: false, status: 404 });
    expect(accessOf("user_bob").workflow("users/user_bob/workflow/x.workflow.json")).toMatchObject({
      ok: true,
      exists: false,
    });
    expect(accessOf("user_bob").workflow("shared/template/t.step-template.json")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("stamps a created shared file and forgets a removed one, and leaves user files alone", () => {
    const access = accessOf("user_alice");
    access.created(SHARED, "workflow");
    access.created("users/user_alice/workflow/mine.workflow.json", "workflow");
    expect(creators.creatorOf(SHARED, "workflow")).toBe("user_alice");
    expect(creators.countBy("user_alice")).toBe(1);

    access.removed(SHARED, "workflow");
    expect(creators.creatorOf(SHARED, "workflow")).toBeUndefined();
  });

  it("refuses a file over the file size only under limits", () => {
    const own = join(projectDir, "users/user_a/workflow/big.workflow.json");
    const big = { text: "x".repeat(20) };
    expect(
      accessOf("user_a", { ...DEFAULT_LIMITS, maxFileBytes: 10 }).write(
        own,
        "workflow",
        big,
        CREATE,
      ),
    ).toMatchObject({ ok: false, status: 403, code: "authored.file-too-large" });
    const local = writeAccess(authoredLayout({ projectDir }), creators);
    expect(local.sizeRefusal(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(local.write(join(projectDir, SHARED), "workflow", big, CREATE)).toMatchObject({
      ok: true,
    });
  });
});
