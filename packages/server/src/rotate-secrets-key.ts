import { existsSync } from "node:fs";
import { dbFilePath } from "@path/engine";
import { userDir, userIds } from "./host-layout.js";
import { openSecretStore, type SecretStore, type SecretsKey } from "./secret-store.js";

export type RotateSecretsKeyResult =
  | { success: true; stores: number; rows: number }
  | { success: false; error: string };

/**
 * Re-encrypts every row of every user's Secret store under `key`, reading rows still under
 * `previous`. Rows already under `key` stay, so a rerun after an interruption finishes the work.
 * A store that fails is named and the others still rotate.
 */
export function rotateSecretsKey({
  projectDir,
  key,
  previous,
}: {
  projectDir: string;
  key: SecretsKey;
  previous: SecretsKey | undefined;
}): RotateSecretsKeyResult {
  const problems: string[] = [];
  let stores = 0;
  let rows = 0;
  for (const userId of userIds(projectDir)) {
    const dbFile = dbFilePath(userDir(projectDir, userId));
    if (!existsSync(dbFile)) continue;
    let store: SecretStore | undefined;
    try {
      store = openSecretStore(dbFile, key, previous);
      rows += store.reencrypt();
      stores += 1;
    } catch (err) {
      problems.push(`users/${userId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      store?.close();
    }
  }
  if (problems.length > 0) return { success: false, error: problems.join("\n") };
  return { success: true, stores, rows };
}
