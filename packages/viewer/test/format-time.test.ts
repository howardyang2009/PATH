import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../src/format-time.js";

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
