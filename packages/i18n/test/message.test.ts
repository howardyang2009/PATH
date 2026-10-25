import { createTranslator } from "use-intl/core";
import { describe, expect, it } from "vitest";
import { type Message, renderMessage, type Translate } from "../src/message.js";
import { loadMessages } from "../src/messages.js";

describe("renderMessage", () => {
  it("renders a key from the catalogue", async () => {
    const t = createTranslator({ locale: "en", messages: await loadMessages("en") });
    expect(renderMessage(t, { key: "viewer.app.title" })).toBe("PATH by RheinWeg · viewer");
  });

  it("renders a Message nested in another's params first", () => {
    const seen: [string, unknown][] = [];
    const t: Translate = (key, values) => {
      seen.push([key, values]);
      return key === "designer.app.title" ? "inner" : `outer(${values?.inner})`;
    };
    const message: Message = {
      key: "viewer.app.title",
      params: { inner: { key: "designer.app.title" }, count: 2 },
    };
    expect(renderMessage(t, message)).toBe("outer(inner)");
    expect(seen.at(-1)).toEqual(["viewer.app.title", { inner: "inner", count: 2 }]);
  });

  it("rejects a key that is not in the catalogue at compile time", () => {
    // @ts-expect-error: not an `en` key
    const message: Message = { key: "viewer.app.nope" };
    expect(message.key).toBe("viewer.app.nope");
  });
});

describe("loadMessages", () => {
  it("loads every Locale's catalogue", async () => {
    for (const locale of ["de", "en", "zh-CN"] as const) {
      expect((await loadMessages(locale)).viewer.app.title).toBeTruthy();
    }
  });
});
