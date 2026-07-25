import { describe, expect, it } from "vitest";
import { formatClockTime, formatTimestamp } from "../src/format-time.js";

describe("formatTimestamp", () => {
  it("renders a timestamp in the viewer's own locale and time zone", () => {
    const iso = "2026-07-25T10:00:00.000Z";
    expect(formatTimestamp(iso)).toBe(
      new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" }),
    );
  });

  it("renders an em dash for a run that never started", () => {
    expect(formatTimestamp(null)).toBe("—");
  });
});

describe("formatClockTime", () => {
  it("drops the date and keeps milliseconds — events in one run share a day but not a millisecond", () => {
    const formatted = formatClockTime("2026-07-25T10:00:00.123Z");
    expect(formatted).toMatch(/^\d{2}:\d{2}:\d{2}\D\d{3}$/);
  });

  it("keeps one width for two events a millisecond apart", () => {
    expect(formatClockTime("2026-07-25T10:00:00.001Z")).toHaveLength(formatClockTime("2026-07-25T23:59:59.999Z").length);
  });
});
