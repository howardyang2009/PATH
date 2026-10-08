#!/usr/bin/env -S npx tsx
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSnapshot, takeBackup, verifyBackup } from "../src/backup.js";
import {
  parseBackupArgs,
  parseRemapUserArgs,
  parseRemoveSharedArgs,
  parseRotateSecretsKeyArgs,
  parseServerArgs,
} from "../src/cli.js";
import { startPathServer } from "../src/create-server.js";
import { listClerkUsers, pairsFromClerkUsers, remapUser } from "../src/remap-user.js";
import { removeShared } from "../src/remove-shared.js";
import { rotateSecretsKey } from "../src/rotate-secrets-key.js";
import { parseSecretsKey } from "../src/secret-store.js";

const argv = process.argv.slice(2);
if (argv[0] === "remove-shared") {
  runRemoveShared(argv.slice(1));
} else if (argv[0] === "backup") {
  runBackup(argv.slice(1)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
} else if (argv[0] === "rotate-secrets-key") {
  try {
    runRotateSecretsKey(argv.slice(1));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
} else if (argv[0] === "remap-user") {
  runRemapUser(argv.slice(1)).catch((err) => {
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

// The new key is PATH_SECRETS_KEY and the old one PATH_SECRETS_KEY_PREVIOUS, the same pair the
// Server reads while rows move.
function runRotateSecretsKey(args: string[]): void {
  const parsed = parseRotateSecretsKeyArgs(args);
  if (!parsed.success) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  const raw = process.env.PATH_SECRETS_KEY;
  if (!raw) throw new Error("rotate-secrets-key needs the new key in PATH_SECRETS_KEY");
  const previous = process.env.PATH_SECRETS_KEY_PREVIOUS;
  const result = rotateSecretsKey({
    projectDir: parsed.args.projectDir,
    key: parseSecretsKey(raw),
    previous: previous ? parseSecretsKey(previous, "PATH_SECRETS_KEY_PREVIOUS") : undefined,
  });
  if (!result.success) {
    console.error(
      `Rotation incomplete; check that PATH_SECRETS_KEY_PREVIOUS holds the old key, then rerun:\n${result.error}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Every row is under the new key id: ${result.rows} re-encrypted in ${result.stores} user stores`,
  );
}

// With --from-clerk the pairs come from the production instance CLERK_SECRET_KEY names: each user
// imported with external_id = their development id.
async function runRemapUser(args: string[]): Promise<void> {
  const parsed = parseRemapUserArgs(args);
  if (!parsed.success) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  let pairs = parsed.args.pairs;
  if (parsed.args.fromClerk) {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) throw new Error("remap-user --from-clerk needs CLERK_SECRET_KEY");
    pairs = pairsFromClerkUsers(await listClerkUsers(secretKey));
    if (pairs.length === 0) throw new Error("no Clerk user has an external_id");
  }
  const { dryRun, deleteSource, projectDir } = parsed.args;
  const result = remapUser({
    projectDir,
    pairs,
    dryRun,
    deleteSource,
    skipEmpty: parsed.args.fromClerk,
  });
  for (const report of result.reports) {
    if (report.nothingToMove) {
      console.log(`${report.from} -> ${report.to}: nothing to move, skipped`);
      continue;
    }
    const rows = Object.entries(report.rows)
      .map(([table, n]) => `${table} ${n}`)
      .join(", ");
    console.log(`${report.from} -> ${report.to}`);
    console.log(`  ${report.files} files, ${report.bytes} bytes; rows: ${rows || "no store"}`);
    console.log(
      `  rewrites: ${report.workflowPaths} workflow_path, ${report.refs.length} refs; ${report.creatorRows} creator rows`,
    );
    for (const ref of report.refs) console.log(`    ${ref.file}: ${ref.from} -> ${ref.to}`);
    for (const entry of report.notCopied)
      console.log(`  not copied (not a regular file): ${entry}`);
    for (const ref of report.sharedRefs) {
      console.log(
        `  shared ref into users/${report.from}/, not rewritten: ${ref.file}: ${ref.ref}`,
      );
    }
    for (const conflict of report.conflicts) console.log(`  conflict: ${conflict}`);
  }
  if (!result.success) {
    console.error(result.error);
    process.exitCode = 1;
    return;
  }
  if (dryRun) {
    console.log("Dry run: nothing changed");
    return;
  }
  for (const { from, to } of result.reports.filter((report) => !report.nothingToMove)) {
    console.log(
      `Remapped ${from} to ${to}${deleteSource ? "; source deleted" : "; source kept (--delete-source removes it)"}`,
    );
    console.log(
      `  VM-time usage stays under ${from}. Move any overrides of ${from} in .path/limits.json to ${to}, then restart the Server.`,
    );
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
