import { type MessageFormatElement, parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { type ErrorCode, englishErrorTemplates, englishText } from "@path/i18n";
import { describe, expect, it } from "vitest";
import { oldErrorCode } from "../src/old-error-code.js";

/** Sample params for `template`: a distinct word per argument, `plural` for each plural selector,
 * and for each select its first listed key (`"first"`) or a word it does not list (`"other"`). */
function sampleParams(template: string, plural: number, select: "first" | "other") {
  const params: Record<string, string | number> = {};
  const visit = (elements: MessageFormatElement[]): void => {
    for (const element of elements) {
      if (element.type === TYPE.argument) params[element.value] ??= `v${element.value}`;
      if (element.type === TYPE.plural) params[element.value] = plural;
      if (element.type === TYPE.select) {
        const first = Object.keys(element.options).find((key) => key !== "other");
        params[element.value] = select === "first" ? (first ?? "other") : "zunlisted";
      }
      if (element.type === TYPE.plural || element.type === TYPE.select)
        for (const option of Object.values(element.options)) visit(option.value);
    }
  };
  visit(parse(template));
  return params;
}

const templates = englishErrorTemplates();
const templateOf = new Map(templates);

describe("oldErrorCode", () => {
  it("reads the errors catalogue", () => {
    expect(templateOf.get("spawn.exited-with-tail")).toBe("exited with code {code}: {tail}");
  });

  it.each(templates)("round-trips errors.%s through its generated regex", (code, template) => {
    for (const [plural, select] of [
      [2, "first"],
      [1, "other"],
    ] as const) {
      const params = sampleParams(template, plural, select);
      const text = englishText({ key: `errors.${code}`, params });
      const matched = oldErrorCode(text);
      // Two codes may share one English template; then either code is the same English text.
      expect(templateOf.get(matched!.code)).toBe(template);
      expect(englishText({ key: `errors.${matched!.code}`, params: matched!.params })).toBe(text);
      if (select === "first") expect(matched!.params).toEqual(params);
    }
  });

  it("decodes an old spawn error into its code and params", () => {
    expect(oldErrorCode("exited with code 3: boom")).toEqual({
      code: "spawn.exited-with-tail" satisfies ErrorCode,
      params: { code: "3", tail: "boom" },
    });
  });

  it("decodes the error inside an old step error as a nested message", () => {
    expect(oldErrorCode('step "boom": exited with code 3: boom')).toEqual({
      code: "step.failed" satisfies ErrorCode,
      params: {
        name: "boom",
        error: { key: "errors.spawn.exited-with-tail", params: { code: "3", tail: "boom" } },
      },
    });
  });

  it("keeps a param that is not an error as text, even when it reads like one", () => {
    expect(oldErrorCode('step "not found": exited with code 3')?.params.name).toBe("not found");
  });

  it("matches nothing for text PATH does not own", () => {
    expect(oldErrorCode("TypeError: cannot read properties of undefined")).toBeUndefined();
  });
});
