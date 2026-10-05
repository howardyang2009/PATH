import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { openCreatorTable } from "../src/creator-table.js";
import { removeShared } from "../src/remove-shared.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NOW = new Date("2026-10-05T12:00:00Z");
const SHARED = "shared/workflow/abuse.workflow.json";

let projectDir: string;
let handle: PathServerHandle | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-remove-shared-test-"));
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  rmSync(projectDir, { recursive: true, force: true });
});

function write(relPath: string, bytes = "{}"): void {
  mkdirSync(dirname(join(projectDir, relPath)), { recursive: true });
  writeFileSync(join(projectDir, relPath), bytes);
}

function stamp(projectPath: string, userId: string): void {
  const creators = openCreatorTable(join(projectDir, ".path", "host.db"));
  creators.stamp(projectPath, "workflow", userId);
  creators.close();
}

function creatorOf(projectPath: string): string | undefined {
  const creators = openCreatorTable(join(projectDir, ".path", "host.db"));
  const creator = creators.creatorOf(projectPath, "workflow");
  creators.close();
  return creator;
}

function logLines(): Record<string, unknown>[] {
  return readFileSync(join(projectDir, ".path", "remove-shared.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("removeShared", () => {
  it("quarantines the file under a dated folder, forgets the creator and logs the removal", () => {
    write(SHARED, '{"bad":true}');
    stamp(SHARED, "user_spam");

    const result = removeShared({ projectDir, path: SHARED, reason: "spam", now: NOW });

    expect(result).toMatchObject({ success: true, creator: "user_spam" });
    expect(existsSync(join(projectDir, SHARED))).toBe(false);
    const quarantined = join(projectDir, ".path", "quarantine", "2026-10-05", SHARED);
    expect(readFileSync(quarantined, "utf8")).toBe('{"bad":true}');
    expect(creatorOf(SHARED)).toBeUndefined();
    expect(logLines()).toEqual([
      {
        time: NOW.toISOString(),
        path: SHARED,
        kind: "workflow",
        creator: "user_spam",
        reason: "spam",
        action: "quarantine",
      },
    ]);
  });

  it("deletes at once with purge and keeps no quarantine copy", () => {
    write(SHARED);
    stamp(SHARED, "user_spam");

    const result = removeShared({
      projectDir,
      path: SHARED,
      reason: "spam",
      purge: true,
      now: NOW,
    });

    expect(result).toMatchObject({ success: true });
    expect(existsSync(join(projectDir, SHARED))).toBe(false);
    expect(existsSync(join(projectDir, ".path", "quarantine", "2026-10-05"))).toBe(false);
    expect(logLines()[0]).toMatchObject({ action: "purge", creator: "user_spam" });
  });

  it("logs a file with no creator row as created by nobody", () => {
    write(SHARED);
    removeShared({ projectDir, path: SHARED, reason: "hand-placed", now: NOW });
    expect(logLines()[0]).toMatchObject({ creator: null, reason: "hand-placed" });
  });

  it("keeps an earlier quarantined copy of the same path on the same day", () => {
    write(SHARED, "first");
    removeShared({ projectDir, path: SHARED, reason: "r", now: NOW });
    write(SHARED, "second");
    removeShared({ projectDir, path: SHARED, reason: "r", now: NOW });

    const day = join(projectDir, ".path", "quarantine", "2026-10-05");
    expect(readFileSync(join(day, SHARED), "utf8")).toBe("first");
    expect(readFileSync(join(day, `${SHARED}.1`), "utf8")).toBe("second");
  });

  it("deletes a quarantine day folder once its last file has sat 30 days, and keeps younger ones", () => {
    write(".path/quarantine/2026-09-04/shared/workflow/old.workflow.json");
    write(".path/quarantine/2026-09-05/shared/workflow/young.workflow.json");
    write(SHARED);

    const result = removeShared({ projectDir, path: SHARED, reason: "r", now: NOW });

    expect(result).toMatchObject({ success: true, expired: ["2026-09-04"] });
    expect(existsSync(join(projectDir, ".path", "quarantine", "2026-09-04"))).toBe(false);
    expect(existsSync(join(projectDir, ".path", "quarantine", "2026-09-05"))).toBe(true);
  });

  it("reports private copies with the same content and leaves them in place", () => {
    write(SHARED, "same bytes");
    write("users/user_a/workflow/copy.workflow.json", "same bytes");
    write("users/user_b/template/deep/also.step-template.json", "same bytes");
    write("users/user_b/workflow/other.workflow.json", "other bytes");
    write("shared/workflow/twin.workflow.json", "same bytes");

    const result = removeShared({
      projectDir,
      path: SHARED,
      reason: "r",
      findCopies: true,
      now: NOW,
    });

    expect(result).toMatchObject({
      success: true,
      copies: [
        "users/user_a/workflow/copy.workflow.json",
        "users/user_b/template/deep/also.step-template.json",
      ],
    });
    expect(existsSync(join(projectDir, "users/user_a/workflow/copy.workflow.json"))).toBe(true);
    expect(existsSync(join(projectDir, "shared/workflow/twin.workflow.json"))).toBe(true);
  });

  it("removes a shared template and its creator row", () => {
    const path = "shared/template/t.step-template.json";
    write(path);
    const creators = openCreatorTable(join(projectDir, ".path", "host.db"));
    creators.stamp(path, "template", "user_spam");
    creators.close();

    expect(removeShared({ projectDir, path, reason: "r", now: NOW })).toMatchObject({
      success: true,
      creator: "user_spam",
    });
    expect(existsSync(join(projectDir, ".path", "quarantine", "2026-10-05", path))).toBe(true);
    expect(logLines()[0]).toMatchObject({ kind: "template", creator: "user_spam" });
  });

  it("drops the item's edit-lease marker", () => {
    write(SHARED);
    write(`${SHARED}.editing`, "{}");
    removeShared({ projectDir, path: SHARED, reason: "r", now: NOW });
    expect(existsSync(join(projectDir, `${SHARED}.editing`))).toBe(false);
  });

  it("refuses a path that is not a shared item, and a missing file", () => {
    write("users/user_a/workflow/mine.workflow.json");
    write(`${SHARED}.editing`);
    expect(removeShared({ projectDir, path: `${SHARED}.editing`, reason: "r" })).toMatchObject({
      success: false,
      error: expect.stringContaining("not a shared item"),
    });
    expect(
      removeShared({ projectDir, path: "users/user_a/workflow/mine.workflow.json", reason: "r" }),
    ).toMatchObject({ success: false, error: expect.stringContaining("not a shared item") });
    expect(removeShared({ projectDir, path: SHARED, reason: "r" })).toMatchObject({
      success: false,
      error: expect.stringContaining("no file"),
    });
    expect(existsSync(join(projectDir, "users/user_a/workflow/mine.workflow.json"))).toBe(true);
  });

  it("hides the item from a running Server; its runs keep history, Resume and Complete answer 404", async () => {
    write(SHARED, readFileSync(join(fixturesDir, "awaiting-complete.workflow.json"), "utf8"));
    handle = await startPathServer(projectDir);
    const listed = async (): Promise<string[]> => {
      const res = await fetch(`${handle!.url}/v0/workflows`);
      const body = (await res.json()) as { workflows: { relative_path: string }[] };
      return body.workflows.map((w) => w.relative_path);
    };
    expect(await listed()).toContain(SHARED);
    const launched = await fetch(`${handle.url}/v0/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_path: SHARED }),
    });
    expect(launched.status).toBe(202);
    const { root_run_id: rootRunId } = (await launched.json()) as { root_run_id: string };
    const tree = async () => (await fetch(`${handle!.url}/v0/runs/${rootRunId}`)).json();
    let leafId: string | undefined;
    for (let i = 0; i < 100 && leafId === undefined; i++) {
      const t = (await tree()) as { runs: { run_id: string; status: string }[] };
      leafId = t.runs.find((r) => r.status === "awaiting")?.run_id;
      if (leafId === undefined) await new Promise((r) => setTimeout(r, 20));
    }

    expect(leafId).toBeDefined();

    expect(removeShared({ projectDir, path: SHARED, reason: "abuse" })).toMatchObject({
      success: true,
    });

    expect(await listed()).not.toContain(SHARED);
    expect((await fetch(`${handle.url}/v0/runs/${rootRunId}`)).status).toBe(200);
    const post = (url: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(`${handle.url}/v0/runs/${leafId}/complete`, { output: {} })).status).toBe(
      404,
    );
    expect((await post(`${handle.url}/v0/runs/${rootRunId}/resume`, {})).status).toBe(404);
  });
});
