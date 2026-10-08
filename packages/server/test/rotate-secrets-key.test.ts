import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rotateSecretsKey } from "../src/rotate-secrets-key.js";
import { openSecretStore, parseSecretsKey, type SecretsKey } from "../src/secret-store.js";

function newKey(): SecretsKey {
  return parseSecretsKey(randomBytes(32).toString("base64"));
}

let projectDir: string;
let oldKey: SecretsKey;
let key: SecretsKey;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-rotate-test-"));
  oldKey = newKey();
  key = newKey();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function userDb(userId: string): string {
  return join(projectDir, "users", userId, ".path", "path.db");
}

function seed(userId: string, under: SecretsKey, secrets: Record<string, string>): void {
  mkdirSync(dirname(userDb(userId)), { recursive: true });
  const store = openSecretStore(userDb(userId), under);
  for (const [name, value] of Object.entries(secrets)) store.set(name, value);
  store.close();
}

function keyIds(userId: string): string[] {
  const db = new Database(userDb(userId), { readonly: true });
  const rows = db.prepare("SELECT key_id FROM user_secrets ORDER BY name").all() as {
    key_id: string;
  }[];
  db.close();
  return rows.map((row) => row.key_id);
}

function values(userId: string): Record<string, string> {
  const store = openSecretStore(userDb(userId), key);
  try {
    return { ...store.values() };
  } finally {
    store.close();
  }
}

describe("rotateSecretsKey", () => {
  it("moves every row of every user's store to the new key id", () => {
    seed("user_a", oldKey, { A_TOKEN: "a-value", B_TOKEN: "b-value" });
    seed("user_b", oldKey, { C_TOKEN: "c-value" });
    mkdirSync(join(projectDir, "users", "user_c"), { recursive: true });

    expect(rotateSecretsKey({ projectDir, key, previous: oldKey })).toEqual({
      success: true,
      stores: 2,
      rows: 3,
    });

    expect(keyIds("user_a")).toEqual([key.id, key.id]);
    expect(keyIds("user_b")).toEqual([key.id]);
    expect(values("user_a")).toEqual({ A_TOKEN: "a-value", B_TOKEN: "b-value" });
    expect(values("user_b")).toEqual({ C_TOKEN: "c-value" });
  });

  it("finishes an interrupted rotation on rerun", () => {
    seed("user_a", oldKey, { A_TOKEN: "a-value" });
    seed("user_b", oldKey, { B_TOKEN: "b-value" });
    // An interrupted pass: user_a moved, user_b not yet.
    const partial = openSecretStore(userDb("user_a"), key, oldKey);
    partial.reencrypt();
    partial.close();

    expect(rotateSecretsKey({ projectDir, key, previous: oldKey })).toEqual({
      success: true,
      stores: 2,
      rows: 1,
    });
    expect(rotateSecretsKey({ projectDir, key, previous: oldKey })).toEqual({
      success: true,
      stores: 2,
      rows: 0,
    });
    expect(keyIds("user_b")).toEqual([key.id]);
    expect(values("user_b")).toEqual({ B_TOKEN: "b-value" });
  });

  it("names a store with a row under an unknown key, and still rotates the others", () => {
    seed("user_a", newKey(), { A_TOKEN: "a-value" });
    seed("user_b", oldKey, { B_TOKEN: "b-value" });

    const result = rotateSecretsKey({ projectDir, key, previous: oldKey });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/users\/user_a: .*key id/),
    });
    expect(keyIds("user_b")).toEqual([key.id]);
  });

  it("names a store that does not open, and still rotates the others", () => {
    mkdirSync(dirname(userDb("user_a")), { recursive: true });
    writeFileSync(userDb("user_a"), "not a database file, long enough to have a header");
    seed("user_b", oldKey, { B_TOKEN: "b-value" });

    expect(rotateSecretsKey({ projectDir, key, previous: oldKey })).toMatchObject({
      success: false,
      error: expect.stringMatching(/^users\/user_a: /),
    });
    expect(keyIds("user_b")).toEqual([key.id]);
  });

  it("answers zero stores for a project with no users", () => {
    expect(rotateSecretsKey({ projectDir, key, previous: undefined })).toEqual({
      success: true,
      stores: 0,
      rows: 0,
    });
  });
});
