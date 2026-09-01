/**
 * Timestamp formatting for the run surfaces, rendered in the author's locale and time zone: these are
 * wall-clock times compared against the author's own terminal, not a stable serialization (ADR 0025
 * keeps presentation per-surface). The Designer's copy.
 */

/** A run that never started has no `started_at` (it is still `pending`) — an em dash keeps grids aligned. */
export function formatTimestamp(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
}

/**
 * Time of day with milliseconds, for a narrative row: every event in one run happens on the same day,
 * so the date is noise in a dense list — and sub-second resolution is what separates events the engine
 * emitted back to back. 24-hour, because the column has to stay one width.
 */
export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}
