import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { rootRunTreeDir } from "../persistence/paths.js";
import type { LogBackend } from "./log-backend.js";

/**
 * The NDJSON log backend (mvp spec §8.1–8.2): one `run.log` per root run at the run-tree root,
 * opening with the `{"type":"log-header","format":"path/log@0","run_id":...}` header line, then one
 * JSON line per event in `seq` order (nested runs interleave, matching per-root `seq`).
 *
 * Local backend: the async seam resolves synchronously over a held file descriptor. The engine
 * serializes `write` calls, so appends never interleave.
 */
export function createNdjsonBackend(projectDir: string): LogBackend {
  let fd: number | null = null;

  function writeLine(obj: unknown): void {
    if (fd === null) throw new Error("ndjson log backend: write before open");
    writeSync(fd, `${JSON.stringify(obj)}\n`);
  }

  return {
    async open({ runId, format }) {
      const dir = rootRunTreeDir(projectDir, runId);
      mkdirSync(dir, { recursive: true });
      fd = openSync(join(dir, "run.log"), "w");
      writeLine({ type: "log-header", format, run_id: runId });
    },
    async write(event) {
      writeLine(event);
    },
    async close() {
      if (fd !== null) {
        closeSync(fd);
        fd = null;
      }
    },
  };
}
