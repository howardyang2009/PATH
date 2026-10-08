import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { openCreatorTable } from "../src/creator-table.js";
import { pairsFromClerkUsers, remapUser } from "../src/remap-user.js";
import { openSecretStore, parseSecretsKey } from "../src/secret-store.js";
import { clerkToken, hostedMode, SECRETS_KEY, stubHostedEnv } from "./fixtures/clerk-token.js";

/**
 * `path-server remap-user` (docs/spec/path-website.md §9): an offline copy of one user's authored
 * files and store to a new user id, with the old id rewritten where the data names it.
 */

const NEW = "user_newowner";

let projectDir: string;
let shippedDir: string;
let handle: PathServerHandle | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-remap-project-"));
  shippedDir = mkdtempSync(join(tmpdir(), "path-remap-shipped-"));
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(shippedDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function start(): Promise<string> {
  handle = await startPathServer(
    projectDir,
    0,
    undefined,
    undefined,
    undefined,
    join(shippedDir, "template"),
    join(shippedDir, "workflow"),
    process.env.CLERK_JWT_KEY ? hostedMode(projectDir) : undefined,
  );
  return handle.url;
}

async function stop(): Promise<void> {
  await handle?.close();
  handle = undefined;
}

function writeJson(relPath: string, value: unknown): void {
  const abs = join(projectDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(value));
}

function readJson(relPath: string): { body: { ref?: string }[] } {
  return JSON.parse(readFileSync(join(projectDir, relPath), "utf8"));
}

/** A workflow whose one step prints `text`; `refs` adds a nested `workflow` step per ref. */
function workflow(relPath: string, { refs = [] as string[], text = "hi" } = {}): string {
  writeJson(relPath, {
    format: "path/workflow@6",
    id: randomUUID(),
    name: "echo",
    body: [
      {
        type: "binary",
        id: randomUUID(),
        name: "echo",
        command: "node",
        args: ["-e", `process.stdout.write(${JSON.stringify(text)})`],
      },
      ...refs.map((ref, i) => ({ type: "workflow", id: randomUUID(), name: `child${i}`, ref })),
    ],
  });
  return relPath;
}

/** Every file under the project with its size and mtime, to show nothing changed. */
function snapshot(): string[] {
  return readdirSync(projectDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const abs = join(entry.parentPath, entry.name);
      const stat = statSync(abs);
      return `${abs} ${stat.size} ${stat.mtimeMs}`;
    })
    .sort();
}

function workflowPaths(storeDb: string): (string | null)[] {
  const db = new Database(storeDb, { readonly: true });
  const rows = db.prepare("SELECT workflow_path FROM runs ORDER BY run_id").all() as {
    workflow_path: string | null;
  }[];
  db.close();
  return rows.map((row) => row.workflow_path);
}

/** Seeds a `local` store with one root run row naming `workflowPath`. */
async function localRun(workflowPath: string): Promise<string> {
  const url = await start();
  const res = await fetch(`${url}/v0/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_path: workflowPath }),
  });
  expect(res.status).toBe(202);
  const { root_run_id: rootRunId } = (await res.json()) as { root_run_id: string };
  for (let i = 0; i < 200; i++) {
    const tree = (await (await fetch(`${url}/v0/runs/${rootRunId}`)).json()) as { status: string };
    if (!["pending", "running", "awaiting"].includes(tree.status)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await stop();
  return rootRunId;
}

describe("remapUser", () => {
  it("moves local's authored files and runs to a new id that sees them in hosted mode", async () => {
    const path = workflow("users/local/workflow/echo.workflow.json", { text: "remapped" });
    const rootRunId = await localRun(path);

    const result = remapUser({ projectDir, pairs: [{ from: "local", to: NEW }] });
    expect(result.success).toBe(true);
    expect(workflowPaths(join(projectDir, "users", NEW, ".path", "path.db"))).toContain(
      `users/${NEW}/workflow/echo.workflow.json`,
    );

    stubHostedEnv();
    const url = await start();
    const auth = { headers: { Authorization: `Bearer ${clerkToken({ sub: NEW })}` } };
    const runs = (await (await fetch(`${url}/v0/runs`, auth)).json()) as {
      runs: { run_id: string; workflow_path: string }[];
    };
    expect(runs.runs).toMatchObject([
      { run_id: rootRunId, workflow_path: `users/${NEW}/workflow/echo.workflow.json` },
    ]);
    const output = await fetch(`${url}/v0/runs/${rootRunId}/blobs/${rootRunId}/output`, auth);
    expect(output.status).toBe(200);
    const workflows = (await (await fetch(`${url}/v0/workflows`, auth)).json()) as {
      workflows: { relative_path: string }[];
    };
    expect(workflows.workflows.map((w) => w.relative_path)).toContain(
      `users/${NEW}/workflow/echo.workflow.json`,
    );
  });

  it("moves a user's secrets with their store", () => {
    const key = parseSecretsKey(SECRETS_KEY);
    const dbFile = (userId: string) => join(projectDir, "users", userId, ".path", "path.db");
    mkdirSync(dirname(dbFile("user_old")), { recursive: true });
    const old = openSecretStore(dbFile("user_old"), key);
    old.set("API_TOKEN", "secret-value");
    old.close();

    expect(remapUser({ projectDir, pairs: [{ from: "user_old", to: NEW }] }).success).toBe(true);

    const moved = openSecretStore(dbFile(NEW), key);
    expect(moved.values()).toEqual({ API_TOKEN: "secret-value" });
    moved.close();
  });

  it("rewrites refs that name the old root and leaves relative ones", () => {
    workflow("users/local/workflow/child.workflow.json");
    workflow("users/local/workflow/parent.workflow.json", {
      refs: ["child.workflow.json", "../../local/workflow/child.workflow.json"],
    });
    workflow("shared/workflow/team.workflow.json");
    workflow("users/local/workflow/uses-shared.workflow.json", {
      refs: ["../../../shared/workflow/team.workflow.json"],
    });

    const result = remapUser({ projectDir, pairs: [{ from: "local", to: NEW }] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.reports[0]?.refs).toEqual([
      {
        file: `users/${NEW}/workflow/parent.workflow.json`,
        from: "../../local/workflow/child.workflow.json",
        to: "child.workflow.json",
      },
    ]);
    expect(readJson(`users/${NEW}/workflow/parent.workflow.json`).body.map((n) => n.ref)).toEqual([
      undefined,
      "child.workflow.json",
      "child.workflow.json",
    ]);
    expect(
      readJson(`users/${NEW}/workflow/uses-shared.workflow.json`).body.map((n) => n.ref),
    ).toEqual([undefined, "../../../shared/workflow/team.workflow.json"]);
  });

  it("moves the old id's creator rows to the new id", () => {
    workflow("users/local/workflow/a.workflow.json");
    const creators = openCreatorTable(join(projectDir, ".path", "host.db"));
    creators.stamp("shared/workflow/mine.workflow.json", "workflow", "local");
    creators.stamp("shared/workflow/theirs.workflow.json", "workflow", "user_other");
    creators.close();

    const result = remapUser({ projectDir, pairs: [{ from: "local", to: NEW }] });
    expect(result.success && result.reports[0]?.creatorRows).toBe(1);

    const after = openCreatorTable(join(projectDir, ".path", "host.db"));
    expect(after.creatorOf("shared/workflow/mine.workflow.json", "workflow")).toBe(NEW);
    expect(after.creatorOf("shared/workflow/theirs.workflow.json", "workflow")).toBe("user_other");
    after.close();
  });

  it("refuses a non-empty target and writes nothing", () => {
    workflow("users/local/workflow/a.workflow.json");
    workflow(`users/${NEW}/workflow/existing.workflow.json`);
    const before = snapshot();

    const result = remapUser({ projectDir, pairs: [{ from: "local", to: NEW }] });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain(`users/${NEW}/ is not empty`);
    expect(snapshot()).toEqual(before);
  });

  it("changes nothing on a dry run and reports what it would do", async () => {
    workflow("users/local/workflow/child.workflow.json");
    const path = workflow("users/local/workflow/a.workflow.json", {
      refs: ["../../local/workflow/child.workflow.json"],
    });
    await localRun(path);
    const creators = openCreatorTable(join(projectDir, ".path", "host.db"));
    creators.stamp("shared/workflow/mine.workflow.json", "workflow", "local");
    creators.close();
    const before = snapshot();

    const result = remapUser({ projectDir, pairs: [{ from: "local", to: NEW }], dryRun: true });

    expect(snapshot()).toEqual(before);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [report] = result.reports;
    expect(report).toMatchObject({
      from: "local",
      to: NEW,
      workflowPaths: 1,
      creatorRows: 1,
      conflicts: [],
    });
    expect(report?.files).toBeGreaterThan(1);
    expect(report?.bytes).toBeGreaterThan(0);
    expect(report?.rows.runs).toBeGreaterThan(0);
    expect(report?.refs).toHaveLength(1);
  });

  it("reports conflicts on a dry run without failing it", () => {
    workflow("users/local/workflow/a.workflow.json");
    workflow(`users/${NEW}/workflow/existing.workflow.json`);

    const result = remapUser({ projectDir, pairs: [{ from: "local", to: NEW }], dryRun: true });

    expect(result.success).toBe(true);
    expect(result.success && result.reports[0]?.conflicts).toEqual([`users/${NEW}/ is not empty`]);
  });

  it("keeps the source unless deleteSource is set", async () => {
    await localRun(workflow("users/local/workflow/a.workflow.json"));
    expect(remapUser({ projectDir, pairs: [{ from: "local", to: NEW }] }).success).toBe(true);
    expect(existsSync(join(projectDir, "users/local/workflow/a.workflow.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".path/path.db"))).toBe(true);

    expect(
      remapUser({ projectDir, pairs: [{ from: NEW, to: "user_third" }], deleteSource: true })
        .success,
    ).toBe(true);
    expect(existsSync(join(projectDir, "users", NEW))).toBe(false);
    expect(existsSync(join(projectDir, "users/user_third/.path/path.db"))).toBe(true);
  });

  it("deletes local's store from the project .path but keeps host files", async () => {
    await localRun(workflow("users/local/workflow/a.workflow.json"));
    writeFileSync(join(projectDir, ".path", "limits.json"), "{}");

    const result = remapUser({
      projectDir,
      pairs: [{ from: "local", to: NEW }],
      deleteSource: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(join(projectDir, "users/local"))).toBe(false);
    expect(existsSync(join(projectDir, ".path/path.db"))).toBe(false);
    expect(existsSync(join(projectDir, ".path/runs"))).toBe(false);
    expect(existsSync(join(projectDir, ".path/host.db"))).toBe(true);
    expect(existsSync(join(projectDir, ".path/limits.json"))).toBe(true);
    expect(existsSync(join(projectDir, "users", NEW, ".path", "host.db"))).toBe(false);
    expect(existsSync(join(projectDir, "users", NEW, ".path", "limits.json"))).toBe(false);
  });

  it("refuses while the Server runs", async () => {
    workflow("users/local/workflow/a.workflow.json");
    await start();

    const result = remapUser({ projectDir, pairs: [{ from: "local", to: NEW }] });
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toContain("Server is running");
    expect(existsSync(join(projectDir, "users", NEW))).toBe(false);

    await stop();
    expect(remapUser({ projectDir, pairs: [{ from: "local", to: NEW }] }).success).toBe(true);
  });

  it("refuses a missing source, an unsafe id and a target named twice", () => {
    workflow("users/user_a/workflow/a.workflow.json");
    workflow("users/user_b/workflow/b.workflow.json");
    const failed = (pairs: { from: string; to: string }[]) => {
      const result = remapUser({ projectDir, pairs });
      return result.success ? "" : result.error;
    };
    expect(failed([{ from: "user_none", to: NEW }])).toContain("nothing to move");
    expect(failed([{ from: "user_a", to: "../escape" }])).toContain("not a valid user id");
    expect(failed([{ from: "user_a", to: "local" }])).toContain("not a valid user id");
    expect(
      failed([
        { from: "user_a", to: NEW },
        { from: "user_b", to: NEW },
      ]),
    ).toContain("more than once");
    expect(
      failed([
        { from: "user_a", to: NEW },
        { from: "user_a", to: "user_other" },
      ]),
    ).toContain("users/user_a/ is named more than once");
  });

  it("skips a pair with nothing to move when skipEmpty is set and moves the rest", () => {
    workflow("users/user_a/workflow/a.workflow.json");

    const result = remapUser({
      projectDir,
      pairs: [
        { from: "user_a", to: NEW },
        { from: "user_empty", to: "user_fresh" },
      ],
      skipEmpty: true,
    });

    expect(result.success).toBe(true);
    expect(result.success && result.reports.map((r) => r.nothingToMove)).toEqual([false, true]);
    expect(existsSync(join(projectDir, "users", NEW, "workflow/a.workflow.json"))).toBe(true);
    expect(existsSync(join(projectDir, "users/user_fresh"))).toBe(false);
  });

  it("undoes every copy when one pair fails, so a rerun starts clean", () => {
    workflow("users/user_a/workflow/a.workflow.json");
    workflow("users/user_b/workflow/b.workflow.json");
    const locked = "users/user_b/notes.txt";
    writeFileSync(join(projectDir, locked), "unreadable");
    const creators = openCreatorTable(join(projectDir, ".path", "host.db"));
    creators.stamp("shared/workflow/a.workflow.json", "workflow", "user_a");
    creators.close();
    chmodSync(join(projectDir, locked), 0o000);
    const pairs = [
      { from: "user_a", to: "user_a2" },
      { from: "user_b", to: "user_b2" },
    ];

    const result = remapUser({ projectDir, pairs, deleteSource: true });

    expect(result.success).toBe(false);
    expect(!result.success && result.error).toContain("nothing was changed");
    expect(existsSync(join(projectDir, "users/user_a2"))).toBe(false);
    expect(existsSync(join(projectDir, "users/user_b2"))).toBe(false);
    expect(existsSync(join(projectDir, "users/user_a/workflow/a.workflow.json"))).toBe(true);
    const after = openCreatorTable(join(projectDir, ".path", "host.db"));
    expect(after.creatorOf("shared/workflow/a.workflow.json", "workflow")).toBe("user_a");
    after.close();

    chmodSync(join(projectDir, locked), 0o644);
    expect(remapUser({ projectDir, pairs }).success).toBe(true);
  });

  it("lists a running Server as a conflict on a dry run", async () => {
    workflow("users/local/workflow/a.workflow.json");
    await start();

    const result = remapUser({ projectDir, pairs: [{ from: "local", to: NEW }], dryRun: true });

    expect(result.success && result.reports[0]?.conflicts[0]).toMatch(/the Server is running/);
  });

  it("lists entries it cannot copy and refuses to delete them with the source", () => {
    workflow("users/user_a/workflow/a.workflow.json");
    symlinkSync("a.workflow.json", join(projectDir, "users/user_a/workflow/link.workflow.json"));
    const pairs = [{ from: "user_a", to: NEW }];

    const dry = remapUser({ projectDir, pairs, dryRun: true });
    expect(dry.success && dry.reports[0]?.notCopied).toEqual([
      "users/user_a/workflow/link.workflow.json",
    ]);
    expect(dry.success && dry.reports[0]?.conflicts).toEqual([]);

    const result = remapUser({ projectDir, pairs, deleteSource: true });
    expect(!result.success && result.error).toContain("would be lost");
    expect(existsSync(join(projectDir, "users/user_a/workflow/a.workflow.json"))).toBe(true);
  });

  it("lists refs in shared files that reach the old folder and leaves them", () => {
    workflow("users/local/workflow/a.workflow.json");
    workflow("shared/workflow/team.workflow.json", {
      refs: ["../../users/local/workflow/a.workflow.json"],
    });

    const result = remapUser({ projectDir, pairs: [{ from: "local", to: NEW }], dryRun: true });

    expect(result.success && result.reports[0]?.sharedRefs).toEqual([
      {
        file: "shared/workflow/team.workflow.json",
        ref: "../../users/local/workflow/a.workflow.json",
      },
    ]);
  });

  it("keeps the project .gitignore when local's store is deleted", async () => {
    await localRun(workflow("users/local/workflow/a.workflow.json"));
    const result = remapUser({
      projectDir,
      pairs: [{ from: "local", to: NEW }],
      deleteSource: true,
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(projectDir, ".path/.gitignore"))).toBe(true);
  });
});

describe("pairsFromClerkUsers", () => {
  it("pairs each user's external_id with their id and skips users without one", () => {
    expect(
      pairsFromClerkUsers([
        { id: "user_new1", externalId: "user_old1" },
        { id: "user_new2", externalId: null },
        { id: "user_new3", externalId: "user_old3" },
      ]),
    ).toEqual([
      { from: "user_old1", to: "user_new1" },
      { from: "user_old3", to: "user_new3" },
    ]);
  });
});
