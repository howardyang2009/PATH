import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LANGS = ["de", "en", "zh"] as const;
const PAGES = ["privacy", "terms"] as const;

function page(lang: string, name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../site/${lang}/${name}.html`, import.meta.url)),
    "utf8",
  );
}

/** The first element `<tag class="name">…</tag>` in `html`, or `""` when there is none. */
function block(html: string, tag: string, name: string): string {
  return html.match(new RegExp(`<${tag} class="${name}"[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "");
}

const CASES = LANGS.flatMap((lang) => PAGES.map((name) => [lang, name] as const));

describe("the legal pages", () => {
  it.each(CASES)("%s/%s links the same page in the other languages, not its own", (lang, name) => {
    const row = block(page(lang, name), "nav", "langs");
    const others = LANGS.filter((other) => other !== lang).map((other) => `/${other}/${name}`);
    expect(hrefs(row)).toEqual(others);
    expect(row).toContain('aria-current="page"');
  });

  it.each(CASES)("%s/%s keeps its internal links in its own language", (lang, name) => {
    const html = page(lang, name)
      .replace(block(page(lang, name), "nav", "langs"), "")
      .replace(block(page(lang, name), "p", "courtesy"), "");
    const internal = hrefs(html).filter((href) => href.startsWith("/"));
    expect(internal).toContain("/");
    for (const href of internal) expect(href === "/" || href.startsWith(`/${lang}/`)).toBe(true);
    expect(hrefs(html)).toContain("https://rheinwegde.de/de/impressum/");
  });

  it.each(CASES)("%s/%s writes no cookie: the page has no script", (lang, name) => {
    expect(page(lang, name)).not.toMatch(/<script/i);
  });

  it.each(CASES)(
    "%s/%s has a courtesy note pointing at German unless it is German",
    (lang, name) => {
      const note = block(page(lang, name), "p", "courtesy");
      if (lang === "de") expect(note).toBe("");
      else expect(hrefs(note)).toEqual([`/de/${name}`]);
    },
  );

  it.each(PAGES)("every language of %s carries the same last-updated date", (name) => {
    const dates = LANGS.map((lang) => page(lang, name).match(/<time datetime="([^"]+)">/)?.[1]);
    expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(dates).size).toBe(1);
  });

  it.each(LANGS)("%s/privacy names the RHEINWEG_LOCALE cookie in section 7", (lang) => {
    const section7 = page(lang, "privacy").match(/<h2>7\.[\s\S]*?(?=<h2>8\.)/)?.[0] ?? "";
    expect(section7).toContain("<code>RHEINWEG_LOCALE</code>");
  });
});
