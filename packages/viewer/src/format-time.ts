/** Wall-clock times an operator compares against their own terminal, not a stable serialization. */

/** A run that never started has no `started_at` — an em dash keeps grids aligned. */
export function formatTimestamp(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
}

/** Time of day with milliseconds for a narrative row; 24-hour, so the column stays one width. */
export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}
