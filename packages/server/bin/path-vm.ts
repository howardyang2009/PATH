#!/usr/bin/env -S npx tsx
// The run VM's process (ADR 0091): runs one job file and exports the run's rows.
import { vmMain } from "../src/sandbox/vm-entry.js";

vmMain(process.argv[2] ?? "").catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
