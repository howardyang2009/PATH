import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openProject, pathDir } from "@path/engine";
import { userDir, userIds } from "../host-layout.js";
import {
  recoverFromStaging,
  SANDBOX_DIR,
  SANDBOX_LOST,
  type SandboxOptions,
  stagingDir,
} from "./sandboxed-runs.js";

/**
 * Cleans up after a Server that stopped while VMs ran (ADR 0091): removes every run VM by label,
 * then, for each staging directory a user's store still holds, imports the rows the VM's store
 * kept and ends the rest `failed` ("sandbox lost"). Runs at boot, before any request.
 */
export async function reapSandboxes(
  projectDir: string,
  sandbox: Pick<SandboxOptions, "runtime" | "maxExportBytes" | "maxBlobBytes">,
): Promise<void> {
  for (const name of await sandbox.runtime.list("path.sandbox", "run")) {
    await sandbox.runtime.remove(name);
  }
  for (const userId of userIds(projectDir)) {
    const storeDir = userDir(projectDir, userId);
    if (!existsSync(join(pathDir(storeDir), SANDBOX_DIR))) continue;
    const opened = openProject(storeDir);
    if (!opened.success) {
      console.error(`reaper: cannot open the store of ${userId}: ${opened.error}`);
      continue;
    }
    const store = opened.project;
    try {
      for (const rootRunId of readdirSync(join(pathDir(storeDir), SANDBOX_DIR))) {
        const refusal = recoverFromStaging(store, rootRunId, sandbox);
        if (refusal !== undefined) console.error(`reaper: run ${rootRunId}: ${refusal}`);
        await store.archive.endNonTerminal(rootRunId, "failed", SANDBOX_LOST);
        rmSync(stagingDir(store, rootRunId), { recursive: true, force: true });
      }
    } finally {
      store.close();
    }
  }
}
