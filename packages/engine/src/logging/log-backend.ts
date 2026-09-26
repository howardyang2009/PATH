import type { LogEvent } from "@path/schema";

/** The per-stream format tag; mvp spec §8.1 (NDJSON header line) and §8.2 (`open` argument). */
export const LOG_FORMAT = "path/log@0";
export type LogFormat = typeof LOG_FORMAT;

// A dumb sink for the log-event stream (mvp spec §8.2), **per root run**: backends never assemble
// envelopes, assign `seq`, or mask secrets, and the engine serializes calls onto them.
export interface LogBackend {
  /** `append` (a Complete re-invocation, ADR 0041) adds to `run.log` rather than starting fresh. */
  open(run: { runId: string; format: LogFormat; append?: boolean }): Promise<void>;
  close(): Promise<void>;
  write(event: LogEvent): Promise<void>;
}
