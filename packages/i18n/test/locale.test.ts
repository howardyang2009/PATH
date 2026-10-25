import { describe, expect, it } from "vitest";
import { pickLocale } from "../src/locale.js";

describe("pickLocale", () => {
  it.each([
    ["a valid cookie wins over the browser", "zh-CN", ["de"], "zh-CN"],
    ["an invalid cookie is ignored", "fr", ["de-AT"], "de"],
    ["the first supported browser language wins", undefined, ["fr", "de", "en"], "de"],
    ["the primary subtag is matched case-insensitively", null, ["EN-GB"], "en"],
    ["zh-TW maps to zh-CN", undefined, ["zh-TW"], "zh-CN"],
    ["zh-Hans maps to zh-CN", undefined, ["zh-Hans"], "zh-CN"],
    ["no supported language gives en", undefined, ["fr", "ja"], "en"],
    ["no cookie and no languages gives en", undefined, [], "en"],
  ] as const)("%s", (_, cookie, languages, expected) => {
    expect(pickLocale(cookie, languages)).toBe(expected);
  });
});
