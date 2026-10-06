import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { UserSecrets } from "@path/engine";
import type { WireSecretSummary } from "@path/schema";
import Database from "better-sqlite3";

// One user's Secret store (ADR 0089): User secrets as rows in their own `path.db`, each value
// encrypted with AES-256-GCM under the host master key. No method returns a value except `values`,
// which only a run launch reads.

/** The host master key and the id each row records, so a later rotation can tell keys apart. */
export interface SecretsKey {
  id: string;
  key: Buffer;
}

export const MAX_SECRET_NAME_LENGTH = 128;
export const MAX_SECRET_VALUE_BYTES = 64 * 1024;
export const MAX_SECRETS_PER_USER = 100;

/** Host variables a run VM still receives, so no User secret may shadow one. */
export const HOST_ENV_ALLOWLIST: readonly string[] = ["DEEPSEEK_BASE_URL"];

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_NAMES = new Set(["PATH", "HOME", "USER", "SHELL", "TMPDIR", ...HOST_ENV_ALLOWLIST]);
const RESERVED_PREFIXES = ["NODE_", "LD_", "DYLD_", "PATH_"];

export interface SecretStore {
  /** Sets or replaces `name`; a refusal message when a limit or a reserved name stops it. */
  set(
    name: string,
    value: string,
  ): { ok: true; summary: WireSecretSummary } | { ok: false; message: string };
  list(): WireSecretSummary[];
  /** `false` when no User secret has that name. */
  remove(name: string): boolean;
  /** Every User secret decrypted, for the environment of a run the user launches. */
  values(): UserSecrets;
  close(): void;
}

/** Reads `PATH_SECRETS_KEY`: 32 bytes in base64 (`openssl rand -base64 32`). The key id is a hash
 * prefix, so it changes with the key and reveals nothing about it. */
export function parseSecretsKey(raw: string): SecretsKey {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("PATH_SECRETS_KEY must be 32 bytes in base64 (openssl rand -base64 32)");
  }
  return { id: createHash("sha256").update(key).digest("hex").slice(0, 16), key };
}

/** Why `name` may not be stored, or `undefined` when it may. */
export function secretNameRefusal(name: string): string | undefined {
  if (!SECRET_NAME.test(name) || name.length > MAX_SECRET_NAME_LENGTH) {
    return `User secret name "${name}" must match ^[A-Z_][A-Z0-9_]*$ and be at most ${MAX_SECRET_NAME_LENGTH} characters`;
  }
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return `User secret name "${name}" is reserved`;
  }
  return undefined;
}

interface SecretRow {
  name: string;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
}

/** Opens the Secret store in the `path.db` at `dbFile`, creating its table if absent. */
export function openSecretStore(dbFile: string, key: SecretsKey): SecretStore {
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_secrets (
      name TEXT PRIMARY KEY,
      key_id TEXT NOT NULL,
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const upsert = db.prepare<[string, string, Buffer, Buffer, string]>(
    "INSERT OR REPLACE INTO user_secrets (name, key_id, nonce, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const exists = db.prepare<[string], { name: string }>(
    "SELECT name FROM user_secrets WHERE name = ?",
  );
  const count = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM user_secrets");
  const summaries = db.prepare<[], WireSecretSummary>(
    "SELECT name, updated_at FROM user_secrets ORDER BY name",
  );
  const rows = db.prepare<[], SecretRow>(
    "SELECT name, key_id, nonce, ciphertext FROM user_secrets ORDER BY name",
  );
  const remove = db.prepare<[string]>("DELETE FROM user_secrets WHERE name = ?");

  // The name is the additional authenticated data, so a ciphertext copied to another row fails.
  function encrypt(name: string, value: string): { nonce: Buffer; ciphertext: Buffer } {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
    cipher.setAAD(Buffer.from(name, "utf8"));
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
  }

  function decrypt(row: SecretRow): string {
    if (row.key_id !== key.id) {
      throw new Error(
        `User secret "${row.name}" is under key id ${row.key_id}, not the loaded key`,
      );
    }
    const decipher = createDecipheriv("aes-256-gcm", key.key, row.nonce);
    decipher.setAAD(Buffer.from(row.name, "utf8"));
    decipher.setAuthTag(row.ciphertext.subarray(-16));
    return Buffer.concat([
      decipher.update(row.ciphertext.subarray(0, -16)),
      decipher.final(),
    ]).toString("utf8");
  }

  return {
    set(name, value) {
      const refusal = secretNameRefusal(name);
      if (refusal !== undefined) return { ok: false, message: refusal };
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
        const message = `User secret "${name}" is larger than ${MAX_SECRET_VALUE_BYTES / 1024} KiB`;
        return { ok: false, message };
      }
      const isNew = exists.get(name) === undefined;
      if (isNew && (count.get()?.n ?? 0) >= MAX_SECRETS_PER_USER) {
        return { ok: false, message: `at most ${MAX_SECRETS_PER_USER} User secrets per user` };
      }
      const { nonce, ciphertext } = encrypt(name, value);
      const summary = { name, updated_at: new Date().toISOString() };
      upsert.run(name, key.id, nonce, ciphertext, summary.updated_at);
      return { ok: true, summary };
    },
    list: () => summaries.all(),
    remove: (name) => remove.run(name).changes > 0,
    values() {
      const out: { [name: string]: string } = {};
      for (const row of rows.all()) out[row.name] = decrypt(row);
      return out;
    },
    close: () => db.close(),
  };
}
