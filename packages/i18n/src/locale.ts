/** The Locales PATH ships, as written in the `RHEINWEG_LOCALE` cookie. */
export const LOCALES = ["de", "en", "zh-CN"] as const;

export type Locale = (typeof LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return (LOCALES as readonly unknown[]).includes(value);
}

/**
 * The active Locale: a valid cookie value, else the first preferred language whose primary subtag
 * is `de`, `en` or `zh` (every `zh*` tag is `zh-CN`), else `en`.
 */
export function pickLocale(
  cookieValue: string | null | undefined,
  preferredLanguages: readonly string[],
): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  for (const tag of preferredLanguages) {
    const primary = tag.split("-")[0]?.toLowerCase();
    if (primary === "de" || primary === "en") return primary;
    if (primary === "zh") return "zh-CN";
  }
  return "en";
}

/** The `RHEINWEG_LOCALE` value in a `Cookie` header, or `undefined` when it is absent. */
export function localeCookie(cookieHeader: string): string | undefined {
  for (const pair of cookieHeader.split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === "RHEINWEG_LOCALE") return value.join("=");
  }
  return undefined;
}
