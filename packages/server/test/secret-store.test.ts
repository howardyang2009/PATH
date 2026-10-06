import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SECRET_VALUE_BYTES,
  MAX_SECRETS_PER_USER,
  openSecretStore,
  parseSecretsKey,
  type SecretStore,
  type SecretsKey,
} from "../src/secret-store.js";

const VALUE = "sk-live-0123456789abcdef";

function newKey(): SecretsKey {
  return parseSecretsKey(randomBytes(32).toString("base64"));
}

describe("parseSecretsKey", () => {
  it("accepts 32 base64 bytes and derives a stable key id", () => {
    const raw = randomBytes(32).toString("base64");
    const a = parseSecretsKey(raw);
    const b = parseSecretsKey(raw);
    expect(a.key).toHaveLength(32);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(newKey().id);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => parseSecretsKey(randomBytes(16).toString("base64"))).toThrow(/PATH_SECRETS_KEY/);
    expect(() => parseSecretsKey("")).toThrow(/PATH_SECRETS_KEY/);
  });
});

describe("openSecretStore", () => {
  let dir: string;
  let dbFile: string;
  let key: SecretsKey;
  let store: SecretStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "path-secret-store-"));
    dbFile = join(dir, "path.db");
    key = newKey();
    store = openSecretStore(dbFile, key);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets, lists without values, and reads back for a run", () => {
    expect(store.set("OPENAI_API_KEY", VALUE)).toEqual({
      ok: true,
      summary: { name: "OPENAI_API_KEY", updated_at: expect.any(String) },
    });
    const listed = store.list();
    expect(listed).toEqual([{ name: "OPENAI_API_KEY", updated_at: expect.any(String) }]);
    expect(JSON.stringify(listed)).not.toContain(VALUE);
    expect(store.values()).toEqual({ OPENAI_API_KEY: VALUE });
  });

  it("replaces a value under the same name", () => {
    store.set("TOKEN", "first-value");
    store.set("TOKEN", "second-value");
    expect(store.list()).toHaveLength(1);
    expect(store.values()).toEqual({ TOKEN: "second-value" });
  });

  it("removes a name, and answers false for an unknown one", () => {
    store.set("TOKEN", VALUE);
    expect(store.remove("TOKEN")).toBe(true);
    expect(store.remove("TOKEN")).toBe(false);
    expect(store.values()).toEqual({});
  });

  it("stores the row encrypted, with the key id", () => {
    store.set("TOKEN", VALUE);
    const db = new Database(dbFile, { readonly: true });
    const row = db.prepare("SELECT * FROM user_secrets").get() as Record<string, unknown>;
    db.close();
    expect(row.key_id).toBe(key.id);
    expect(JSON.stringify(row)).not.toContain(VALUE);
    expect(Buffer.from(row.ciphertext as Buffer).toString("utf8")).not.toContain(VALUE);
  });

  it("keeps the values across a reopen under the same key", () => {
    store.set("TOKEN", VALUE);
    store.close();
    store = openSecretStore(dbFile, key);
    expect(store.values()).toEqual({ TOKEN: VALUE });
  });

  it("refuses to read a row under a key it does not hold", () => {
    store.set("TOKEN", VALUE);
    store.close();
    store = openSecretStore(dbFile, newKey());
    expect(() => store.values()).toThrow(/key id/);
  });

  it.each([
    ["lowercase", "api_key"],
    ["a leading digit", "1KEY"],
    ["a dash", "API-KEY"],
    ["more than 128 characters", `A${"B".repeat(128)}`],
  ])("refuses a name with %s", (_why, name) => {
    expect(store.set(name, VALUE)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/name/),
    });
  });

  it.each([
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "PATH_SECRETS_KEY",
    "DEEPSEEK_BASE_URL",
  ])("refuses the reserved name %s", (name) => {
    expect(store.set(name, VALUE)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/reserved/),
    });
  });

  it("refuses a value over the size limit", () => {
    expect(store.set("BIG", "x".repeat(MAX_SECRET_VALUE_BYTES + 1))).toMatchObject({ ok: false });
    expect(store.set("BIG", "x".repeat(MAX_SECRET_VALUE_BYTES))).toMatchObject({ ok: true });
  });

  it("refuses a new name past the count limit, but still replaces an existing one", () => {
    for (let i = 0; i < MAX_SECRETS_PER_USER; i += 1) store.set(`KEY_${i}`, `value-${i}`);
    expect(store.set("ONE_MORE", VALUE)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/100/),
    });
    expect(store.set("KEY_0", VALUE)).toMatchObject({ ok: true });
  });
});
