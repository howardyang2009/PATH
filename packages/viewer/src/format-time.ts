/**
 * Timestamp formatting shared by the runs list and the run-detail head. Rendered in the viewer's
 * locale and time zone: these are wall-clock times an operator compares against their own terminal,
 * not a stable serialization.
 */

/** A run that never started has no `started_at` (it is still `pending`) — an em dash keeps grids aligned. */
export function formatTimestamp(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
}
