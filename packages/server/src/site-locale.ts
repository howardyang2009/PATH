import type { IncomingMessage } from "node:http";
import { type Locale, localeCookie, pickLocale } from "@path/i18n";

/** The URL path segment per Locale: the legal pages live under `/de`, `/en` and `/zh`. */
export const LOCALE_PATH_SEGMENTS: Record<Locale, string> = { de: "de", en: "en", "zh-CN": "zh" };

/** The request's Locale: the `RHEINWEG_LOCALE` cookie, else `Accept-Language`, else `en`. */
export function requestLocale(req: IncomingMessage): Locale {
  return pickLocale(localeCookie(req.headers.cookie ?? ""), preferredLanguages(req));
}

/** The `Accept-Language` tags, highest `q` first; a tag with `q=0` is refused, so it is dropped. */
function preferredLanguages(req: IncomingMessage): string[] {
  return (req.headers["accept-language"] ?? "")
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q.slice(2)) };
    })
    .filter(({ tag, q }) => tag !== "" && q > 0)
    .sort((a, b) => b.q - a.q)
    .map(({ tag }) => tag);
}
