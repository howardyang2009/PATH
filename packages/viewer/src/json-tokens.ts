/** Splits pretty-printed JSON (known-valid `JSON.stringify` output) into colour spans; tokens are
 *  slices of the input, so re-joining reproduces the document byte for byte. */

export type JsonTokenKind = "key" | "string" | "number" | "boolean" | "null" | "plain";

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

/**
 * Strings first: a colon inside a value (`"[secret:github_token]"`, the masked form) is not a key
 * separator. The trailing `\s*:` group promotes a string to a key; it is emitted as plain text so the
 * join stays lossless.
 */
const TOKEN_PATTERN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

export function tokenizeJson(json: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let cursor = 0;

  TOKEN_PATTERN.lastIndex = 0;
  for (let match = TOKEN_PATTERN.exec(json); match !== null; match = TOKEN_PATTERN.exec(json)) {
    const [whole, stringText, colon, numberText, wordText] = match;
    if (match.index > cursor) {
      tokens.push({ kind: "plain", text: json.slice(cursor, match.index) });
    }

    if (stringText !== undefined) {
      tokens.push({ kind: colon === undefined ? "string" : "key", text: stringText });
      if (colon !== undefined) tokens.push({ kind: "plain", text: colon });
    } else if (numberText !== undefined) {
      tokens.push({ kind: "number", text: numberText });
    } else if (wordText !== undefined) {
      tokens.push({ kind: wordText === "null" ? "null" : "boolean", text: wordText });
    }

    cursor = match.index + whole.length;
  }

  if (cursor < json.length) tokens.push({ kind: "plain", text: json.slice(cursor) });
  return tokens;
}
