#!/usr/bin/env -S npx tsx
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSnapshot, takeBackup, verifyBackup } from "../src/backup.js";
import { parseBackupArgs, parseRemoveSharedArgs, parseServerArgs } from "../src/cli.js";
import { startPathServer } from "../src/create-server.js";
import { removeShared } from "../src/remove-shared.js";

const argv = process.argv.slice(2);
if (argv[0] === "remove-shared") {
  runRemoveShared(argv.slice(1));
} else if (argv[0] === "backup") {
  runBackup(argv.slice(1)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
} else {
  serve(argv);
}

function runRemoveShared(args: string[]): void {
  const parsed = parseRemoveSharedArgs(args);
  if (!parsed.success) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  const result = removeShared(parsed.args);
  if (!result.success) {
    console.error(result.error);
    process.exitCode = 1;
    return;
  }
  const creator = result.creator ?? "no creator row";
  console.log(
    result.action === "purge"
      ? `Deleted ${result.projectPath} (${creator})`
      : `Quarantined ${result.projectPath} (${creator}) to ${result.quarantinedTo}`,
  );
  for (const day of result.expired) console.log(`Deleted expired quarantine ${day}`);
  if (parsed.args.findCopies) {
    console.log(`${result.copies.length} private copies (not changed)`);
    for (const copy of result.copies) console.log(`  ${copy}`);
  }
}

async function runBackup(args: string[]): Promise<void> {
  const parsed = parseBackupArgs(args);
  if (!parsed.success) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  if (parsed.args.command === "take") {
    const result = await takeBackup(parsed.args);
    if (!result.success) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Snapshot in ${parsed.args.outDir} (${result.manifest.databases.length} databases)`,
    );
    return;
  }

  // Without --snapshot, restore the latest restic snapshot; restic reads its repository and
  // password from the environment (packages/server/backup/backup.env.example).
  let restored: string | undefined;
  let snapshotDir = parsed.args.snapshotDir;
  try {
    if (snapshotDir === undefined) {
      restored = mkdtempSync(join(tmpdir(), "path-backup-restore-"));
      const restic = spawnSync(
        "restic",
        ["restore", "latest", "--tag", "path", "--target", restored],
        {
          stdio: "inherit",
        },
      );
      if (restic.status !== 0) {
        console.error(
          `restic restore failed (${restic.error?.message ?? `exit ${restic.status}`})`,
        );
        process.exitCode = 1;
        return;
      }
      snapshotDir = findSnapshot(restored);
      if (snapshotDir === undefined) {
        console.error("The restored restic snapshot holds no PATH backup");
        process.exitCode = 1;
        return;
      }
    }
    const result = await verifyBackup({ snapshotDir });
    if (!result.success) {
      console.error(`Backup verify failed:\n${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Backup verify passed: ${result.databases} databases, ${result.stores} user stores, Server booted`,
    );
  } finally {
    if (restored !== undefined) rmSync(restored, { recursive: true, force: true });
  }
}

function serve(args: string[]): void {
  const parsed = parseServerArgs(args);
  if (!parsed.success) {
    console.error(parsed.error);
    process.exitCode = 2;
  } else {
    startPathServer(parsed.args.projectDir, parsed.args.port).then(
      (handle) => {
        console.log(`Listening on ${handle.url}`);
        // The listen socket keeps the event loop alive, so without this the process never exits on a
        // signal — the runner (tsx) then SIGKILLs it and the shell reports exit 137. Drain HTTP and
        // the project store, then exit 0. `once` so a second Ctrl-C during shutdown does not re-enter
        // close.
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          process.once(signal, () => {
            handle.close().finally(() => process.exit(0));
          });
        }
      },
      (err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      },
    );
  }
}
