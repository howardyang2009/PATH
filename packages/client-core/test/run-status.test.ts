import { describe, expect, it } from "vitest";
import { RUN_STATUS_ORDER, runStatusReading } from "../src/run-status.js";

describe("runStatusReading — the one status vocabulary", () => {
  it("labels every status from the shared catalogue", () => {
    for (const status of RUN_STATUS_ORDER) {
      expect(runStatusReading(status).message).toEqual({ key: `shared.status.${status}` });
    }
  });

  it("draws the same awaiting glyph the Viewer always used", () => {
    expect(runStatusReading("awaiting").glyph).toBe("⏳");
  });

  it("never leaves a status without a glyph", () => {
    for (const status of RUN_STATUS_ORDER) {
      expect(runStatusReading(status).glyph).not.toBe("");
    }
  });

  it("lists running and awaiting first, and pending last", () => {
    expect(RUN_STATUS_ORDER.slice(0, 2)).toEqual(["running", "awaiting"]);
    expect(RUN_STATUS_ORDER.at(-1)).toBe("pending");
  });
});
