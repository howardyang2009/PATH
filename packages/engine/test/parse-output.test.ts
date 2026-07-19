import { describe, expect, it } from "vitest";
import { OutputParseError, parseStepOutput } from "../src/parse-output.js";

describe("parseStepOutput", () => {
  it("parses plain JSON text", () => {
    expect(parseStepOutput('{"a": 1}')).toEqual({ a: 1 });
  });

  it("strips a surrounding markdown code fence before parsing", () => {
    expect(parseStepOutput('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseStepOutput('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseStepOutput('  \n{"a": 1}\n  ')).toEqual({ a: 1 });
  });

  it("parses arrays and scalars, not just objects", () => {
    expect(parseStepOutput("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseStepOutput("42")).toBe(42);
  });

  it("throws OutputParseError on unparseable text", () => {
    expect(() => parseStepOutput("not json")).toThrow(OutputParseError);
  });
});
