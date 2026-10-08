import { randomBytes } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSnapshot, MANIFEST_FILE, takeBackup, verifyBackup } from "../src/backup.js";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { openCreatorTable } from "../src/creator-table.js";
import { openSecretStore, parseSecretsKey } from "../src/secret-store.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let workDir: string;
let projectDir: string;
let outDir: string;
let handle: PathServerHandle | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "path-backup-test-"));
  projectDir = join(workDir, "project");
  outDir = join(workDir, "snapshot");
  cpSync(fixturesDir, projectDir, { recursive: true });
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

function write(relPath: string, bytes: string | Buffer = "{}"): void {
  mkdirSync(dirname(join(projectDir, relPath)), { recursive: true });
  writeFileSync(join(projectDir, relPath), bytes);
}

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(join(dir, entry.name), rel) : [rel];
  });
}

async function launch(url: string): Promise<void> {
  const res = await fetch(`${url}/v0/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_path: "two-binary-steps.workflow.json" }),
  });
  expect(res.status).toBe(202);
}

describe("takeBackup", () => {
  it("takes a consistent snapshot while runs write: every db passes integrity_check and every blob a row names is there", async () => {
    handle = await startPathServer(projectDir);
    const url = handle.url;
    await Promise.all([launch(url), launch(url)]);
    const writing = Promise.all(Array.from({ length: 8 }, () => launch(url)));
    const result = await takeBackup({ projectDir, outDir });
    await writing;

    expect(result).toMatchObject({ success: true });
    const snapshotDb = join(outDir, "project", ".path", "path.db");
    const db = new Database(snapshotDb, { readonly: true });
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    const refs = db
      .prepare<[], { input_ref: string | null; output_ref: string | null }>(
        "SELECT input_ref, output_ref FROM runs",
      )
      .all()
      .flatMap((row) => [row.input_ref, row.output_ref])
      .filter((ref): ref is string => ref !== null);
    db.close();
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(existsSync(join(outDir, "project", ".path", ref))).toBe(true);
    expect(await verifyBackup({ snapshotDir: outDir })).toMatchObject({ success: true });
  });

  it("holds .path, users/ and shared/ with every db listed in the manifest, and no SQLite side files", async () => {
    write("users/user_a/workflow/mine.workflow.json");
    write("shared/workflow/team.workflow.json");
    write("notes/elsewhere.txt", "not part of the snapshot");
    const creators = openCreatorTable(join(projectDir, ".path", "host.db"));
    creators.stamp("shared/workflow/team.workflow.json", "workflow", "user_a");
    const userDb = join(projectDir, "users", "user_a", ".path", "path.db");
    mkdirSync(dirname(userDb), { recursive: true });
    const secrets = openSecretStore(userDb, parseSecretsKey(randomBytes(32).toString("base64")));

    const result = await takeBackup({ projectDir, outDir });
    creators.close();
    secrets.close();

    expect(result).toMatchObject({ success: true });
    const manifest = JSON.parse(readFileSync(join(outDir, MANIFEST_FILE), "utf8"));
    expect(manifest.databases.sort()).toEqual([".path/host.db", "users/user_a/.path/path.db"]);
    const files = filesUnder(join(outDir, "project"));
    expect(files).toContain("users/user_a/workflow/mine.workflow.json");
    expect(files).toContain("shared/workflow/team.workflow.json");
    expect(files).not.toContain("notes/elsewhere.txt");
    expect(files.filter((f) => /-(wal|shm|journal)$/.test(f))).toEqual([]);
  });

  it("never holds the master key", async () => {
    const raw = randomBytes(32).toString("base64");
    const key = parseSecretsKey(raw);
    const userDb = join(projectDir, "users", "user_a", ".path", "path.db");
    mkdirSync(dirname(userDb), { recursive: true });
    const secrets = openSecretStore(userDb, key);
    secrets.set("API_TOKEN", "value-1");
    secrets.close();

    expect(await takeBackup({ projectDir, outDir })).toMatchObject({ success: true });

    for (const file of filesUnder(outDir)) {
      const bytes = readFileSync(join(outDir, file));
      expect(bytes.includes(Buffer.from(raw))).toBe(false);
      expect(bytes.includes(key.key)).toBe(false);
    }
  });

  it("snapshots a project that holds no data yet", async () => {
    expect(await takeBackup({ projectDir, outDir })).toMatchObject({
      success: true,
      manifest: { databases: [] },
    });
    expect(existsSync(join(outDir, MANIFEST_FILE))).toBe(true);
  });

  it("refuses an out dir that is not empty", async () => {
    write("users/user_a/workflow/mine.workflow.json");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "stale"), "x");
    expect(await takeBackup({ projectDir, outDir })).toMatchObject({
      success: false,
      error: expect.stringContaining("not empty"),
    });
  });
});

describe("verifyBackup", () => {
  async function snapshotWithUser(): Promise<void> {
    const userDb = join(projectDir, "users", "user_a", ".path", "path.db");
    mkdirSync(dirname(userDb), { recursive: true });
    openSecretStore(userDb, parseSecretsKey(randomBytes(32).toString("base64"))).close();
    handle = await startPathServer(projectDir);
    await launch(handle.url);
    await handle.close();
    handle = undefined;
    expect(await takeBackup({ projectDir, outDir })).toMatchObject({ success: true });
  }

  it("passes a good snapshot and leaves it unchanged", async () => {
    await snapshotWithUser();
    const before = filesUnder(outDir).map((f) => [f, statSync(join(outDir, f)).mtimeMs]);

    const result = await verifyBackup({ snapshotDir: outDir });

    expect(result).toEqual({ success: true, databases: 3, stores: 1 });
    expect(filesUnder(outDir).map((f) => [f, statSync(join(outDir, f)).mtimeMs])).toEqual(before);
  });

  it("fails naming the db whose pages are damaged", async () => {
    await snapshotWithUser();
    const damaged = join(outDir, "project", ".path", "path.db");
    const fd = openSync(damaged, "r+");
    writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096);
    closeSync(fd);

    const result = await verifyBackup({ snapshotDir: outDir });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining(".path/path.db"),
    });
  });

  it("fails naming a blob a run row needs that the snapshot lacks", async () => {
    await snapshotWithUser();
    const runs = join(outDir, "project", ".path", "runs");
    rmSync(join(runs, readdirSync(runs)[0] as string), { recursive: true });

    expect(await verifyBackup({ snapshotDir: outDir })).toMatchObject({
      success: false,
      error: expect.stringMatching(/\.path\/path\.db: blob missing: runs\//),
    });
  });

  it("fails when a db the manifest lists is missing, or the manifest itself is", async () => {
    await snapshotWithUser();
    rmSync(join(outDir, "project", "users", "user_a", ".path", "path.db"));
    expect(await verifyBackup({ snapshotDir: outDir })).toMatchObject({
      success: false,
      error: expect.stringContaining("users/user_a/.path/path.db: missing"),
    });
    rmSync(join(outDir, MANIFEST_FILE));
    expect(await verifyBackup({ snapshotDir: outDir })).toMatchObject({
      success: false,
      error: expect.stringContaining(MANIFEST_FILE),
    });
  });
});

describe("findSnapshot", () => {
  it("finds the snapshot a restore put under its target's absolute path", async () => {
    write("users/user_a/workflow/mine.workflow.json");
    const restored = join(workDir, "restored");
    const nested = join(restored, "Users", "owner", "Library", "Caches", "path-backup", "snapshot");
    expect(await takeBackup({ projectDir, outDir: nested })).toMatchObject({ success: true });
    expect(findSnapshot(restored)).toBe(nested);
    expect(findSnapshot(projectDir)).toBeUndefined();
  });
});
