import { describe, expect, it } from "vitest";
import { tokenizeJson, type JsonToken } from "../src/json-tokens.js";

/** The tokens of one kind, in order — what a test asserts about, rather than the whole span list. */
function textOf(tokens: readonly JsonToken[], kind: JsonToken["kind"]): string[] {
  return tokens.filter((token) => token.kind === kind).map((token) => token.text);
}

/** Re-joining every token must reproduce the input exactly: the tokenizer only splits, never edits. */
function joined(tokens: readonly JsonToken[]): string {
  return tokens.map((token) => token.text).join("");
}

describe("tokenizeJson", () => {
  it("separates keys from string values", () => {
    const json = JSON.stringify({ node: "summarize" }, null, 2);
    const tokens = tokenizeJson(json);

    expect(textOf(tokens, "key")).toEqual(['"node"']);
    expect(textOf(tokens, "string")).toEqual(['"summarize"']);
    expect(joined(tokens)).toBe(json);
  });

  it("classifies numbers, booleans and null", () => {
    const json = JSON.stringify({ count: -12.5e3, ok: true, off: false, missing: null }, null, 2);
    const tokens = tokenizeJson(json);

    expect(textOf(tokens, "number")).toEqual(["-12500"]);
    expect(textOf(tokens, "boolean")).toEqual(["true", "false"]);
    expect(textOf(tokens, "null")).toEqual(["null"]);
    expect(joined(tokens)).toBe(json);
  });

  it("does not read a colon inside a string value as a key separator", () => {
    // The masked form of a secret is exactly this shape (CONTEXT.md, Secret), so it is the case the
    // panel renders most often — colouring it as a key would be wrong on every masked run.
    const json = JSON.stringify({ token: "[secret:github_token]" }, null, 2);
    const tokens = tokenizeJson(json);

    expect(textOf(tokens, "key")).toEqual(['"token"']);
    expect(textOf(tokens, "string")).toEqual(['"[secret:github_token]"']);
  });

  it("keeps an escaped quote inside its own string token", () => {
    const json = JSON.stringify({ 'say"hi': 'a "quoted" word' }, null, 2);
    const tokens = tokenizeJson(json);

    expect(textOf(tokens, "key")).toEqual(['"say\\"hi"']);
    expect(textOf(tokens, "string")).toEqual(['"a \\"quoted\\" word"']);
    expect(joined(tokens)).toBe(json);
  });

  it("leaves structure — braces, commas, indentation — as plain text", () => {
    const json = JSON.stringify({ shas: ["b3bf601", "8871a89"] }, null, 2);
    const tokens = tokenizeJson(json);

    expect(textOf(tokens, "string")).toEqual(['"b3bf601"', '"8871a89"']);
    expect(joined(tokens)).toBe(json);
    expect(tokens.some((token) => token.kind === "plain" && token.text.includes("["))).toBe(true);
  });

  it("tokenizes a bare scalar document", () => {
    expect(tokenizeJson("null")).toEqual([{ kind: "null", text: "null" }]);
    expect(tokenizeJson('"done"')).toEqual([{ kind: "string", text: '"done"' }]);
  });
});
