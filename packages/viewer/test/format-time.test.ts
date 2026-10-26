import { describe, expect, it } from "vitest";
import { dateFormat, formatClockTime, formatTimestamp } from "../src/format-time.js";

describe("dateFormat", () => {
  it.each([
    ["en follows the browser's English region", "en", ["fr", "en-US", "en-GB"], "en-US"],
    ["en matches the region case-insensitively", "en", ["EN-au"], "EN-au"],
    ["en skips a bare en tag", "en", ["en", "en-AU"], "en-AU"],
    ["en without an English region is en-GB", "en", ["en", "de-DE"], "en-GB"],
    ["en with no languages is en-GB", "en", [], "en-GB"],
    ["de ignores the browser", "de", ["en-US", "de-AT"], "de"],
    ["zh-CN ignores the browser", "zh-CN", ["zh-TW"], "zh-CN"],
  ] as const)("%s", (_, locale, languages, expected) => {
    expect(dateFormat(locale, languages)).toBe(expected);
  });
});

describe("formatTimestamp", () => {
  const iso = "2026-07-25T10:00:00.000Z";

  it.each([
    ["de", ["en-US"], "de"],
    ["en", ["en-US"], "en-US"],
    ["en", ["en"], "en-GB"],
    ["zh-CN", ["en-US"], "zh-CN"],
  ] as const)(
    "renders the %s Locale with browser %j as %s in the browser's time zone",
    (locale, languages, format) => {
      expect(formatTimestamp(iso, locale, languages)).toBe(
        new Date(iso).toLocaleString(format, { dateStyle: "short", timeStyle: "medium" }),
      );
    },
  );

  it("renders English dates as day/month/year on a 24-hour clock without an English region", () => {
    expect(formatTimestamp(iso, "en", ["en"])).toMatch(/^25\/07\/2026, \d{2}:/);
  });

  it("renders US English dates as month/day/year", () => {
    expect(formatTimestamp(iso, "en", ["en-US"])).toMatch(/^7\/25\/26, /);
  });

  it("renders German dates as day.month.year", () => {
    expect(formatTimestamp("2026-07-25T10:00:00.000Z", "de")).toMatch(/^25\.07\.26/);
  });

  it("renders an em dash for a run that never started", () => {
    expect(formatTimestamp(null, "en")).toBe("—");
  });
});

describe("formatClockTime", () => {
  it("drops the date and keeps milliseconds — events in one run share a day but not a millisecond", () => {
    const formatted = formatClockTime("2026-07-25T10:00:00.123Z", "en");
    expect(formatted).toMatch(/^\d{2}:\d{2}:\d{2}\D\d{3}$/);
  });

  it.each(["de", "en", "zh-CN"] as const)(
    "keeps one width for two events a millisecond apart in the %s Locale",
    (locale) => {
      expect(formatClockTime("2026-07-25T10:00:00.001Z", locale)).toHaveLength(
        formatClockTime("2026-07-25T23:59:59.999Z", locale).length,
      );
    },
  );
});
