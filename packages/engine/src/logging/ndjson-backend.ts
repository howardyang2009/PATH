import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type LogEvent, LogEventSchema } from "@path/schema";
import { rootRunTreeDir } from "../persistence/paths.js";
import type { LogBackend } from "./log-backend.js";

// The NDJSON log backend (mvp spec §8.1–8.2): one `run.log` per root run at the run-tree root, opening
// with the `log-header` line, then one JSON line per event in `seq` order (nested runs interleave).
// Local backend: the async seam resolves synchronously, and the engine serializes `write` calls.
export function createNdjsonBackend(projectDir: string): LogBackend {
  let fd: number | null = null;

  function writeLine(obj: unknown): void {
    if (fd === null) throw new Error("ndjson log backend: write before open");
    writeSync(fd, `${JSON.stringify(obj)}\n`);
  }

  return {
    async open({ runId, format, append }) {
      const dir = rootRunTreeDir(projectDir, runId);
      mkdirSync(dir, { recursive: true });
      const logPath = join(dir, "run.log");
      // Append (a Complete re-invocation, ADR 0041) keeps one continuous per-root stream, header and all;
      // a launch, or a re-invocation whose log was never written, opens `"w"` and writes the header.
      const continuing = append === true && existsSync(logPath);
      fd = openSync(logPath, continuing ? "a" : "w");
      if (!continuing) writeLine({ type: "log-header", format, run_id: runId });
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

// Reads a root run's persisted `run.log` back into its `LogEvent` narrative, in `seq` order, skipping
// the header line. `[]` when the file doesn't exist (the backend was never enabled) — not an error.
export function readNdjsonLog(projectDir: string, rootRunId: string): LogEvent[] {
  const logPath = join(rootRunTreeDir(projectDir, rootRunId), "run.log");
  if (!existsSync(logPath)) return [];
  const events: LogEvent[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const parsed: unknown = JSON.parse(line);
    if ((parsed as { type?: string }).type === "log-header") continue;
    events.push(LogEventSchema.parse(parsed));
  }
  return events;
}
