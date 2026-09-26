import { tokenizeJson } from "./json-tokens.js";

/** Two-space indent: dense enough for a 340px rail, still nested-readable. */
const INDENT = 2;

/** Pretty-printed mono JSON; it scrolls rather than wraps so the indentation carrying structure survives.
 *  `value` is `unknown` because a launch fact's `ConfigObject` carries no index signature. */
export function JsonView({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, INDENT);
  return (
    <pre className="json">
      {tokenizeJson(text).map((token, index) =>
        token.kind === "plain" ? (
          token.text
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens are recomputed from the text; position is identity.
          <span key={index} className={`json-${token.kind}`}>
            {token.text}
          </span>
        ),
      )}
    </pre>
  );
}
