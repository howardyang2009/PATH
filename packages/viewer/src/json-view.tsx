import { tokenizeJson } from "./json-tokens.js";

/** Two-space indent, as in the #44 prototype: dense enough for a 340px rail, still nested-readable. */
const INDENT = 2;

/**
 * One blob rendered as pretty-printed, colour-tokenized JSON in mono (#44: mono for data). The block
 * scrolls on its own axis rather than wrapping — a wrapped JSON line loses the indentation that
 * carries the structure.
 *
 * `value` is `unknown` rather than `JsonValue`: a launch fact's `config` is typed as the domain
 * `ConfigObject`, whose `$secret`/`$env` wrappers are JSON on the wire but carry no index signature,
 * and `JSON.stringify` renders both identically.
 */
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
