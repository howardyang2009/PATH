import type { LogEvent } from "./log-event.js";

/** The per-stream format tag; mvp spec §8.1 (NDJSON header line) and §8.2 (`open` argument). */
export const LOG_FORMAT = "path/log@0";
export type LogFormat = typeof LOG_FORMAT;

/**
 * A dumb sink for the log-event stream (mvp spec §8.2). Instantiated **per root run**; every event
 * of the run tree flows through it in `seq` order. Backends never assemble envelopes, assign `seq`,
 * or mask secrets — the engine delivers fully-formed, already-redacted events, so a backend can't
 * leak what the engine already scrubbed.
 *
 * Signatures are async so a future remote backend fits the same seam; local backends resolve
 * synchronously. The engine serializes calls (one internal write queue per backend, never
 * concurrent `write`s) — an implementation need not guard against re-entrancy itself.
 */
export interface LogBackend {
  open(run: { runId: string; format: LogFormat }): Promise<void>;
  /** Flush; called on run end, success or failure. */
  close(): Promise<void>;
  write(event: LogEvent): Promise<void>;
}
