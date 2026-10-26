import { isLocale, type Locale, localeCookie, pickLocale } from "@path/i18n";

/** What the page knows about its reader's language: `location.search`, `document.cookie` and
 * `navigator.languages`. */
export interface LocaleSources {
  search: string;
  cookie: string;
  languages: readonly string[];
}

/** The page's Locale: a valid `?lang=` (never written to the cookie), else `pickLocale` over the
 * `RHEINWEG_LOCALE` cookie and the browser's languages. */
export function resolveLocale(sources: LocaleSources): Locale {
  const query = new URLSearchParams(sources.search).get("lang");
  if (isLocale(query)) return query;
  return pickLocale(localeCookie(sources.cookie), sources.languages);
}
