import type { Locale } from "@path/i18n";

/** Wall-clock times an operator compares against their own terminal, not a stable serialization.
 * The Locale sets the format; the time zone stays the browser's. */

/** The tag dates format with. `en` takes the browser's first English region (`en-US`, `en-AU`),
 * else `en-GB`; the other Locales ignore the browser. */
export function dateFormat(locale: Locale, languages: readonly string[]): string {
  if (locale !== "en") return locale;
  return languages.find((tag) => /^en-[a-z]{2}$/i.test(tag)) ?? "en-GB";
}

/** A run that never started has no `started_at` — an em dash keeps grids aligned. */
export function formatTimestamp(
  iso: string | null,
  locale: Locale,
  languages: readonly string[] = navigator.languages,
): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleString(dateFormat(locale, languages), {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

/** Time of day with milliseconds for a narrative row; 24-hour, so the column stays one width. */
export function formatClockTime(
  iso: string,
  locale: Locale,
  languages: readonly string[] = navigator.languages,
): string {
  return new Date(iso).toLocaleTimeString(dateFormat(locale, languages), {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}
