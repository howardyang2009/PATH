import { readFileSync } from "node:fs";
import {
  isPluralElement,
  isSelectElement,
  isTagElement,
  type MessageFormatElement,
  parse,
  TYPE,
} from "@formatjs/icu-messageformat-parser";
import { describe, expect, it } from "vitest";
import { LOCALES, type Locale } from "../src/locale.js";

type Catalogue = { [key: string]: string | Catalogue };

/** The plural categories each Locale must write: CLDR's cardinal set for the language. */
const PLURAL_CATEGORIES: Record<Locale, string[]> = {
  de: ["one", "other"],
  en: ["one", "other"],
  "zh-CN": ["other"],
};

function leaves(tree: Catalogue, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of leaves(value, path)) out.set(k, v);
  }
  return out;
}

function walk(elements: MessageFormatElement[], visit: (el: MessageFormatElement) => void): void {
  for (const el of elements) {
    visit(el);
    if (isPluralElement(el) || isSelectElement(el)) {
      for (const option of Object.values(el.options)) walk(option.value, visit);
    }
    if (isTagElement(el)) walk(el.children, visit);
  }
}

function argumentNames(elements: MessageFormatElement[]): string[] {
  const names = new Set<string>();
  walk(elements, (el) => {
    if (el.type !== TYPE.literal && el.type !== TYPE.pound) names.add(el.value);
  });
  return [...names].sort();
}

/** Every rule a Locale's catalogue breaks against `en`, as readable lines; empty when clean. */
function catalogueProblems(en: Catalogue, target: Catalogue, locale: Locale): string[] {
  const problems: string[] = [];
  const source = leaves(en);
  const messages = leaves(target);
  for (const key of source.keys()) if (!messages.has(key)) problems.push(`${key}: missing`);
  for (const [key, text] of messages) {
    const english = source.get(key);
    if (english === undefined) {
      problems.push(`${key}: extra`);
      continue;
    }
    let ast: MessageFormatElement[];
    try {
      ast = parse(text);
    } catch (error) {
      problems.push(`${key}: invalid ICU (${(error as Error).message})`);
      continue;
    }
    const args = argumentNames(ast).join(", ");
    const expected = argumentNames(parse(english)).join(", ");
    if (args !== expected) problems.push(`${key}: arguments [${args}], en has [${expected}]`);
    walk(ast, (el) => {
      if (!isPluralElement(el) || el.pluralType === "ordinal") return;
      const categories = Object.keys(el.options).filter((c) => !c.startsWith("="));
      if (categories.sort().join() !== PLURAL_CATEGORIES[locale].join()) {
        problems.push(`${key}: plural {${el.value}} has [${categories}]`);
      }
    });
  }
  return problems;
}

function load(locale: Locale): Catalogue {
  return JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));
}

describe("catalogues", () => {
  const en = load("en");
  it.each(LOCALES)("%s matches en", (locale) => {
    expect(catalogueProblems(en, load(locale), locale)).toEqual([]);
  });
});

describe("catalogueProblems", () => {
  const en: Catalogue = {
    a: { greet: "Hello {name}" },
    steps: "{count, plural, one {# step} other {# steps}}",
  };
  const clean: Catalogue = {
    a: { greet: "Hallo {name}" },
    steps: "{count, plural, one {# Schritt} other {# Schritte}}",
  };

  it("accepts a clean catalogue", () => {
    expect(catalogueProblems(en, clean, "de")).toEqual([]);
  });

  it("reports a missing and an extra key", () => {
    const target = { ...clean, a: {}, b: "extra" };
    expect(catalogueProblems(en, target, "de")).toEqual(["a.greet: missing", "b: extra"]);
  });

  it("reports an unparsable message", () => {
    const [problem] = catalogueProblems(en, { ...clean, a: { greet: "Hallo {name" } }, "de");
    expect(problem).toMatch(/^a\.greet: invalid ICU/);
  });

  it("reports a changed argument name", () => {
    expect(catalogueProblems(en, { ...clean, a: { greet: "Hallo {user}" } }, "de")).toEqual([
      "a.greet: arguments [user], en has [name]",
    ]);
  });

  it("reports plural branches that do not fit the Locale", () => {
    expect(
      catalogueProblems(en, { ...clean, steps: "{count, plural, other {# Schritte}}" }, "de"),
    ).toEqual(["steps: plural {count} has [other]"]);
    expect(catalogueProblems(en, clean, "zh-CN")).toEqual([
      "steps: plural {count} has [one,other]",
    ]);
    expect(
      catalogueProblems(
        en,
        { a: { greet: "你好 {name}" }, steps: "{count, plural, other {# 个步骤}}" },
        "zh-CN",
      ),
    ).toEqual([]);
  });
});
