import { loadMessages, type Message, renderMessage, type Translate } from "@path/i18n";
import type { Condition } from "@path/schema";
import { createTranslator } from "use-intl/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONDITION_TYPES,
  changeConditionType,
  defaultConditionOfType,
  isLeafConditionType,
  validateCondition,
} from "../src/condition-edit.js";

/** #370 — the pure condition-editing model behind the pane's typed condition builder. */

describe("condition-edit defaults", () => {
  it("mints a structurally-valid condition for every operator", () => {
    for (const type of CONDITION_TYPES) {
      const condition = defaultConditionOfType(type);
      expect(condition.type).toBe(type);
      expect(validateCondition(condition)).toBeNull();
    }
  });

  it("classifies leaves and combinators", () => {
    expect(isLeafConditionType("exists")).toBe(true);
    expect(isLeafConditionType("range")).toBe(true);
    expect(isLeafConditionType("all")).toBe(false);
    expect(isLeafConditionType("not")).toBe(false);
  });
});

describe("changeConditionType carries what the new shape can hold", () => {
  it("keeps the dot-path across a leaf → leaf switch", () => {
    const prev: Condition = { type: "exists", path: "previous.result" };
    const next = changeConditionType(prev, "equals");
    expect(next).toMatchObject({ type: "equals", path: "previous.result" });
    expect(validateCondition(next)).toBeNull();
  });

  it("wraps a leaf when switching to not, and unwraps back", () => {
    const leaf: Condition = { type: "exists", path: "context.x" };
    const wrapped = changeConditionType(leaf, "not");
    expect(wrapped).toEqual({ type: "not", of: leaf });
    // not → all carries the single child into the list.
    const asAll = changeConditionType(wrapped, "all");
    expect(asAll).toEqual({ type: "all", of: [leaf] });
  });

  it("carries the child list between all and any", () => {
    const all: Condition = {
      type: "all",
      of: [
        { type: "exists", path: "context.a" },
        { type: "exists", path: "context.b" },
      ],
    };
    const any = changeConditionType(all, "any");
    expect(any).toEqual({ type: "any", of: all.of });
  });

  it("seeds a valid default child when a leaf becomes a combinator with no child to carry", () => {
    const any = changeConditionType({ type: "valid-json", path: "context.x" }, "any");
    expect(any.type).toBe("any");
    expect(validateCondition(any)).toBeNull();
  });
});

describe("validateCondition rejects an ill-typed condition", () => {
  it("flags a bad dot-path root", () => {
    // `config` is not a legal condition root (ROOTS.condition is context/previous).
    expect(validateCondition({ type: "exists", path: "config.x" } as Condition)).not.toBeNull();
  });

  it("flags a range with neither bound", () => {
    expect(validateCondition({ type: "range", path: "context.n" } as Condition)).not.toBeNull();
  });

  it("returns a PATH refinement as its error code", () => {
    expect(validateCondition({ type: "range", path: "context.n" } as Condition)).toEqual({
      key: "errors.schema.condition.range-bounds",
    });
  });

  it("returns a built-in zod issue as zod's own text", () => {
    expect(
      validateCondition({ type: "one-of", path: "context.n", values: [] } as Condition),
    ).toEqual({ key: "shared.verbatim", params: { text: expect.stringMatching(/>=1/) } });
  });
});

/** What the Designer shows under `?lang=de`: the de catalogue, and zod's de locale that `mountApp`
 * sets. */
async function inGerman(condition: Condition): Promise<string> {
  z.config(z.locales.de());
  const t = createTranslator({ locale: "de", messages: await loadMessages("de") }) as Translate;
  return renderMessage(t, validateCondition(condition) as Message);
}

afterEach(() => {
  z.config(z.locales.en());
});

describe("an invalid condition under ?lang=de", () => {
  it("shows a PATH refinement in German", async () => {
    expect(await inGerman({ type: "range", path: "context.n" } as Condition)).toBe(
      "eine range-Bedingung braucht mindestens min oder max",
    );
  });

  it("shows a built-in zod issue in German", async () => {
    const text = await inGerman({ type: "one-of", path: "context.n", values: [] } as Condition);
    expect(text).toMatch(/^Zu klein/);
  });
});
