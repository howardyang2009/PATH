import { describe, expect, it } from "vitest";
import { formatClockTime, formatTimestamp } from "../src/format-time.js";

describe("formatTimestamp", () => {
  it.each([
    ["de", "de"],
    ["en", "en-GB"],
    ["zh-CN", "zh-CN"],
  ] as const)("renders the %s Locale as %s in the browser's time zone", (locale, format) => {
    const iso = "2026-07-25T10:00:00.000Z";
    expect(formatTimestamp(iso, locale)).toBe(
      new Date(iso).toLocaleString(format, { dateStyle: "short", timeStyle: "medium" }),
    );
  });

  it("renders English dates as day/month/year on a 24-hour clock", () => {
    expect(formatTimestamp("2026-07-25T10:00:00.000Z", "en")).toMatch(/^25\/07\/2026, \d{2}:/);
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
