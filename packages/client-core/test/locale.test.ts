import { describe, expect, it } from "vitest";
import { resolveLocale } from "../src/locale.js";

describe("resolveLocale", () => {
  it.each([
    [
      "?lang= wins over the cookie and the browser",
      "?lang=de",
      "RHEINWEG_LOCALE=zh-CN",
      ["en"],
      "de",
    ],
    ["?lang=zh-CN is read as written", "?x=1&lang=zh-CN", "", ["de"], "zh-CN"],
    ["an invalid ?lang= is ignored", "?lang=fr", "RHEINWEG_LOCALE=de", ["en"], "de"],
    ["the cookie wins over the browser", "", "a=1; RHEINWEG_LOCALE=zh-CN; b=2", ["de"], "zh-CN"],
    ["the browser list decides with no query and no cookie", "", "a=1", ["fr", "de"], "de"],
    ["nothing supported gives en", "", "", ["fr"], "en"],
  ] as const)("%s", (_, search, cookie, languages, expected) => {
    expect(resolveLocale({ search, cookie, languages })).toBe(expected);
  });
});
