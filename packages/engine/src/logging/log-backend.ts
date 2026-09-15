import type { LogEvent } from "@path/schema";

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
  /**
   * Open the stream for one root run. `append` (ADR 0041, a Complete re-invocation) says to add to the
   * existing stream rather than start a fresh one — the NDJSON backend appends to `run.log` and skips
   * a second header; a launch or Resume passes it false/absent and opens fresh. The db backend is
   * append-agnostic: the engine seeds the continuing `seq` so its inserts never collide.
   */
  open(run: { runId: string; format: LogFormat; append?: boolean }): Promise<void>;
  /** Flush; called on run end, success or failure. */
  close(): Promise<void>;
  write(event: LogEvent): Promise<void>;
}
