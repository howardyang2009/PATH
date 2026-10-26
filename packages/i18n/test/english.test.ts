import { describe, expect, it } from "vitest";
import { englishText, isMessageKey } from "../src/english.js";

describe("englishText", () => {
  it("formats a key from the en catalogue with its params", () => {
    expect(englishText({ key: "designer.palette.listFailed", params: { message: "boom" } })).toBe(
      "Could not list templates: boom",
    );
  });

  it("renders a nested Message param first", () => {
    expect(
      englishText({
        key: "designer.palette.listFailed",
        params: { message: { key: "designer.palette.noTemplates" } },
      }),
    ).toBe("Could not list templates: No templates");
  });
});

describe("isMessageKey", () => {
  it("knows a leaf of the en catalogue", () => {
    expect(isMessageKey("shared.verbatim")).toBe(true);
  });

  it("refuses an unknown key and a branch of the tree", () => {
    expect(isMessageKey("errors.no-such-code")).toBe(false);
    expect(isMessageKey("shared")).toBe(false);
  });
});
