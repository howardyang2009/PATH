import { createTranslator } from "use-intl/core";
import { describe, expect, it } from "vitest";
import { englishRendering } from "../src/english.js";
import {
  type Message,
  type Rendering,
  renderMessage,
  type Translate,
  verbatim,
} from "../src/message.js";
import { loadMessages } from "../src/messages.js";

/** One Locale's rendering, the way a surface builds it: its catalogue and its list formatter. */
async function renderingFor(locale: "de" | "en" | "zh-CN"): Promise<Rendering> {
  const t = createTranslator({ locale, messages: await loadMessages(locale) }) as Translate;
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  return { t, list: (items) => list.format(items) };
}

describe("renderMessage", () => {
  it("renders a key from the catalogue", () => {
    expect(renderMessage(englishRendering, { key: "viewer.app.title" })).toBe(
      "PATH by RheinWeg · viewer",
    );
  });

  it("renders a Message nested in another's params first", () => {
    const seen: [string, unknown][] = [];
    const t: Translate = (key, values) => {
      seen.push([key, values]);
      return key === "designer.app.title" ? "inner" : `outer(${values?.inner})`;
    };
    const rendering: Rendering = { t, list: (items) => items.join("|") };
    const message: Message = {
      key: "viewer.app.title",
      params: { inner: { key: "designer.app.title" }, count: 2 },
    };
    expect(renderMessage(rendering, message)).toBe("outer(inner)");
    expect(seen.at(-1)).toEqual(["viewer.app.title", { inner: "inner", count: 2 }]);
  });

  it("joins a param list with the rendering's list formatter", () => {
    const seen: [string, unknown][] = [];
    const t: Translate = (key, values) => {
      seen.push([key, values]);
      return String(values?.items);
    };
    const rendering: Rendering = { t, list: (items) => items.join(" | ") };
    expect(
      renderMessage(rendering, { key: "viewer.app.title", params: { items: ["a", "b"] } }),
    ).toBe("a | b");
    expect(seen.at(-1)).toEqual(["viewer.app.title", { items: "a | b" }]);
  });

  it("writes the list separator of each Locale, not an English comma", async () => {
    const message: Message = {
      key: "events.narrative.joinApplied",
      params: { label: verbatim("fan"), branches: ["a", "b"] },
    };
    expect(renderMessage(await renderingFor("en"), message)).toContain("a and b");
    expect(renderMessage(await renderingFor("de"), message)).toContain("a und b");
    expect(renderMessage(await renderingFor("zh-CN"), message)).toContain("a和b");
  });

  it("renders verbatim text unchanged in every Locale", async () => {
    for (const locale of ["de", "en", "zh-CN"] as const) {
      expect(renderMessage(await renderingFor(locale), verbatim("HTTP 500: {boom}"))).toBe(
        "HTTP 500: {boom}",
      );
    }
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
