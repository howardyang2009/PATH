import type { JsonValue } from "@path/client-core";
import { tokenizeJson } from "./json-tokens.js";

/** Two-space indent, as in the #44 prototype: dense enough for a 340px rail, still nested-readable. */
const INDENT = 2;

/**
 * One blob rendered as pretty-printed, colour-tokenized JSON in mono (#44: mono for data). The block
 * scrolls on its own axis rather than wrapping — a wrapped JSON line loses the indentation that
 * carries the structure.
 */
export function JsonView({ value }: { value: JsonValue }) {
  const text = JSON.stringify(value, null, INDENT);
  return (
    <pre className="json">
      {tokenizeJson(text).map((token, index) =>
        token.kind === "plain" ? (
          token.text
        ) : (
          <span key={index} className={`json-${token.kind}`}>
            {token.text}
          </span>
        ),
      )}
    </pre>
  );
}
