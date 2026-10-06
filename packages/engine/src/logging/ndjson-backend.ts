import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { type LogEvent, LogEventSchema } from "@path/schema";
import { rootRunTreeDir } from "../persistence/paths.js";
import type { LogBackend } from "./log-backend.js";

// The NDJSON log backend (mvp spec §8.1–8.2): one `run.log` per root run at the run-tree root,
// opening with the `log-header` line, then one JSON line per event in `seq` order (nested runs
// interleave). Local backend: the async seam resolves synchronously, and the engine serializes
// `write` calls.
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
      // Append (a Complete re-invocation, ADR 0041) keeps one continuous per-root stream, header
      // and all; a launch, or a re-invocation whose log was never written, opens `"w"` and writes
      // the header.
      const continuing = append === true && existsSync(logPath);
      fd = openSync(logPath, continuing ? "a" : "w");
      if (!continuing) writeLine({ type: "log-header", format, run_id: runId });
      // A torn last line (its writer was killed) must not swallow the next event.
      else if (!endsWithNewline(logPath)) writeSync(fd, "\n");
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

function endsWithNewline(path: string): boolean {
  const { size } = statSync(path);
  if (size === 0) return true;
  const last = Buffer.alloc(1);
  const fd = openSync(path, "r");
  try {
    readSync(fd, last, 0, 1, size - 1);
  } finally {
    closeSync(fd);
  }
  return last[0] === 0x0a;
}

// Reads a root run's persisted `run.log` back into its `LogEvent` narrative, in `seq` order,
// skipping the header line. `[]` when the file doesn't exist (the backend was never enabled) — not
// an error.
export function readNdjsonLog(projectDir: string, rootRunId: string): LogEvent[] {
  const logPath = join(rootRunTreeDir(projectDir, rootRunId), "run.log");
  if (!existsSync(logPath)) return [];
  const events: LogEvent[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn line from a killed writer
    }
    if ((parsed as { type?: string }).type === "log-header") continue;
    // A sandboxed run's `run.log` is written by the VM, so a line that is no event is skipped.
    const event = LogEventSchema.safeParse(parsed);
    if (event.success) events.push(event.data);
  }
  return events;
}
