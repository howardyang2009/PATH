import { describe, expect, it } from "vitest";
import { tokenizeInterpolation, type InterpolationToken } from "../src/interpolation.js";

/**
 * The one place the `${}` grammar is implemented (#68). It was implemented twice — here to
 * validate, and in `@path/engine` to substitute — and the engine's copy was correct only because
 * this one had run first.
 */
function tokens(value: string): InterpolationToken[] {
  return [...tokenizeInterpolation(value)];
}

describe("tokenizeInterpolation", () => {
  it("yields nothing for an empty string", () => {
    expect(tokens("")).toEqual([]);
  });

  it("yields one literal for a string with no placeholders", () => {
    expect(tokens("plain text")).toEqual([{ kind: "literal", text: "plain text" }]);
  });

  it("splits literals around a placeholder", () => {
    expect(tokens("hi ${context.name}!")).toEqual([
      { kind: "literal", text: "hi " },
      { kind: "placeholder", path: "context.name" },
      { kind: "literal", text: "!" },
    ]);
  });

  it("yields a placeholder with no surrounding literals when it is the whole string", () => {
    expect(tokens("${config.x}")).toEqual([{ kind: "placeholder", path: "config.x" }]);
  });

  it("yields consecutive placeholders", () => {
    expect(tokens("${a.b}${c.d}")).toEqual([
      { kind: "placeholder", path: "a.b" },
      { kind: "placeholder", path: "c.d" },
    ]);
  });

  it("treats $${ as an escape, not a placeholder", () => {
    expect(tokens("a $${literal} b")).toEqual([
      { kind: "literal", text: "a " },
      { kind: "escape" },
      { kind: "literal", text: "literal} b" },
    ]);
  });

  it("treats a bare $ as inert literal text", () => {
    expect(tokens("costs $5 and $x")).toEqual([{ kind: "literal", text: "costs $5 and $x" }]);
  });

  it("yields an empty placeholder path for ${}, leaving the judgement to the caller", () => {
    expect(tokens("${}")).toEqual([{ kind: "placeholder", path: "" }]);
  });

  // The failure the engine could not previously see: it scanned for `}` and assumed one existed.
  it("yields `unclosed` for a placeholder with no closing brace, and stops", () => {
    expect(tokens("before ${context.oops")).toEqual([
      { kind: "literal", text: "before " },
      { kind: "unclosed", index: 7 },
    ]);
  });

  it("reports the index of the opening brace of the unclosed placeholder", () => {
    expect(tokens("${a.b} then ${c.d")).toEqual([
      { kind: "placeholder", path: "a.b" },
      { kind: "literal", text: " then " },
      { kind: "unclosed", index: 12 },
    ]);
  });

  it("reassembles the original string from its tokens", () => {
    for (const value of ["", "plain", "a ${x.y} b", "${x.y}", "$${esc}", "costs $5", "${a.b}${c.d}"]) {
      const rebuilt = tokens(value)
        .map((t) => {
          switch (t.kind) {
            case "literal":
              return t.text;
            case "escape":
              return "$${";
            case "placeholder":
              return `\${${t.path}}`;
            case "unclosed":
              return value.slice(t.index);
          }
        })
        .join("");
      expect(rebuilt).toBe(value);
    }
  });
});
