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
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
