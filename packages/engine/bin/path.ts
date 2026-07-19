#!/usr/bin/env -S npx tsx
import { main } from "../src/cli.js";

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
