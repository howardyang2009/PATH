#!/usr/bin/env -S npx tsx
import { parseRemoveSharedArgs, parseServerArgs } from "../src/cli.js";
import { startPathServer } from "../src/create-server.js";
import { removeShared } from "../src/remove-shared.js";

const argv = process.argv.slice(2);
if (argv[0] === "remove-shared") {
  runRemoveShared(argv.slice(1));
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
