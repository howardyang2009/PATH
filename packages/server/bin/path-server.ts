#!/usr/bin/env -S npx tsx
import { parseServerArgs } from "../src/cli.js";
import { startPathServer } from "../src/create-server.js";

const parsed = parseServerArgs(process.argv.slice(2));
if (!parsed.success) {
  console.error(parsed.error);
  process.exitCode = 2;
} else {
  startPathServer(parsed.args.projectDir, parsed.args.port).then(
    (handle) => {
      console.log(`Listening on ${handle.url}`);
      // The listen socket keeps the event loop alive, so without this the process never exits on a
      // signal — the runner (tsx) then SIGKILLs it and the shell reports exit 137. Drain HTTP and the
      // project store, then exit 0. `once` so a second Ctrl-C during shutdown does not re-enter close.
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
