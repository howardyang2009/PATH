/**
 * A minimal JSON tokenizer for the node-I/O panel: it splits an already pretty-printed JSON document
 * into spans the view colours (#44 pinned mono JSON with keys/strings/numbers distinguished). It
 * only *splits* — every token's text is a slice of the input, so re-joining the tokens reproduces
 * the document byte for byte and nothing on screen is ever the tokenizer's invention.
 *
 * Not a parser: the input is `JSON.stringify` output, already known-valid, and the panel needs
 * colour, not structure.
 */

export type JsonTokenKind = "key" | "string" | "number" | "boolean" | "null" | "plain";

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

/**
 * Strings first, so a colon *inside* a value (`"[secret:github_token]"` — the masked form every run
 * carries, CONTEXT.md §Secret) is never mistaken for a key separator. The trailing `\s*:` group is
 * what promotes a string to a key; it is emitted as plain text so the join stays lossless.
 */
const TOKEN_PATTERN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

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
