import { loadMessages } from "@path/i18n";
import { screen } from "@testing-library/react";
import { useLocale } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mountApp } from "../src/mount-app.js";

function LocaleProbe() {
  return <p>locale {useLocale()}</p>;
}

/** Load the page at `search` with `cookie` and the browser's `languages`, then mount the app. */
async function mountAt(
  search: string,
  cookie = "",
  languages = ["en-US"],
  surface: "viewer" | "designer" = "viewer",
) {
  window.history.replaceState(null, "", `/viewer/${search}`);
  vi.spyOn(document, "cookie", "get").mockReturnValue(cookie);
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
  mountApp(surface, () => <LocaleProbe />);
  return (await screen.findByText(/^locale /)).textContent?.replace("locale ", "");
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  document.documentElement.lang = "en";
  vi.stubGlobal("fetch", async () => Response.json({ mode: "local", publishableKey: null }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  z.config(z.locales.en());
});

describe("mountApp", () => {
  it("applies ?lang=de to the app, <html lang>, the title and zod", async () => {
    const cookieWrites = vi.spyOn(document, "cookie", "set");

    expect(await mountAt("?lang=de", "RHEINWEG_LOCALE=zh-CN")).toBe("de");
    expect(document.documentElement.lang).toBe("de");
    expect(document.title).toBe((await loadMessages("de")).viewer.app.title);
    expect(z.string().safeParse(1).error?.issues[0]?.message).toMatch(/Ungültige Eingabe/);
    expect(cookieWrites).not.toHaveBeenCalled();
  });

  it("uses the RHEINWEG_LOCALE cookie when there is no query", async () => {
    expect(await mountAt("", "RHEINWEG_LOCALE=zh-CN", ["de"])).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("titles the Designer from its own catalogue key", async () => {
    expect(await mountAt("?lang=zh-CN", "", ["en-US"], "designer")).toBe("zh-CN");
    expect(document.title).toBe((await loadMessages("zh-CN")).designer.app.title);
  });

  it("keeps en and zod's English for an English browser", async () => {
    expect(await mountAt("")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe((await loadMessages("en")).viewer.app.title);
    expect(z.string().safeParse(1).error?.issues[0]?.message).toMatch(/^Invalid input/);
  });
});
