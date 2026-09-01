import type { JsonValue } from "@path/client-core";
import { tokenizeJson } from "./json-tokens.js";

/** Two-space indent: dense enough for a narrow inspector, still nested-readable. */
const INDENT = 2;

/**
 * One blob rendered as pretty-printed, colour-tokenized JSON in mono. The block scrolls on its own axis
 * rather than wrapping — a wrapped JSON line loses the indentation that carries the structure.
 */
export function JsonView({ value }: { value: JsonValue }): JSX.Element {
  const text = JSON.stringify(value, null, INDENT);
  return (
    <pre className="run-json">
      {tokenizeJson(text).map((token, index) =>
        token.kind === "plain" ? (
          token.text
        ) : (
          <span key={index} className={`run-json-${token.kind}`}>
            {token.text}
          </span>
        ),
      )}
    </pre>
  );
}
