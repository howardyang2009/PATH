import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type LogEvent, LogEventSchema } from "@path/schema";
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
    async open({ runId, format, append }) {
      const dir = rootRunTreeDir(projectDir, runId);
      mkdirSync(dir, { recursive: true });
      const logPath = join(dir, "run.log");
      // A Complete re-invocation appends to the existing `run.log` (ADR 0041) — `"a"` preserves the
      // launch narrative and its header, so the file stays one continuous per-root stream. A launch
      // (or a re-invocation whose log was never written) opens `"w"` and writes the header line.
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

/**
 * Reads a root run's persisted `run.log` back into its `LogEvent` narrative, in `seq` order,
 * skipping the leading `log-header` line (server-api-v0.md §5's historical replay). `[]` if the
 * file doesn't exist — the `ndjson` backend was never enabled for this run (§5's known v0
 * limitation) or it hasn't written anything yet — not an error.
 */
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
