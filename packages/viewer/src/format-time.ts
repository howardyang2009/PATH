import type { Locale } from "@path/i18n";

/** Wall-clock times an operator compares against their own terminal, not a stable serialization.
 * The Locale sets the format; the time zone stays the browser's. */

/** `en` dates read day/month/year on a 24-hour clock, as in `en-GB`, not the US default. */
const DATE_FORMAT: Record<Locale, string> = { de: "de", en: "en-GB", "zh-CN": "zh-CN" };

/** A run that never started has no `started_at` — an em dash keeps grids aligned. */
export function formatTimestamp(iso: string | null, locale: Locale): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleString(DATE_FORMAT[locale], {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

/** Time of day with milliseconds for a narrative row; 24-hour, so the column stays one width. */
export function formatClockTime(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleTimeString(DATE_FORMAT[locale], {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}
