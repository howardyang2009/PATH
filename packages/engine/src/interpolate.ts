import { resolveDotPath as resolvePath, tokenizeInterpolation, type JsonValue } from "@path/schema";

/** The `config`/`context`/`output` values a `${dot.path}` resolves against (format doc §5). */
export type InterpolationScope = { [root: string]: JsonValue };

// Thrown rather than returned as a Result: interpolateValue recurses through arbitrary JSON
// structure, and threading a Result through that walk is noisier than letting run-workflow.ts
// catch this at each call site and translate it into its own Result (`fail(...)`).
export class InterpolationError extends Error {}

// A config value may carry the `{"$secret": "<value>"}` wrapper (format doc §8.3). Interpolation
// resolves to the real value ("workers receive real values" — masking is a persistence-boundary
// concern, ticket #20); this unwrap is transparent regardless of which root it's found under.
function unwrapSecret(value: JsonValue): JsonValue {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $secret?: unknown }).$secret === "string"
  ) {
    return (value as { $secret: string }).$secret;
  }
  return value;
}

// A `$secret` wrapper can sit at any nesting depth inside a config value (ConfigValueSchema
// allows it anywhere), not just at the exact leaf a dot-path lands on — a bare-root or
// ancestor-path interpolation (`${config}`, `${config.nested}`) returns a whole sub-tree that
// must have every wrapper inside it unwrapped too, or a worker would see the wrapper shape
// instead of the real value depending on how the path happened to address it.
function deepUnwrapSecrets(value: JsonValue): JsonValue {
  const unwrapped = unwrapSecret(value);
  if (Array.isArray(unwrapped)) return unwrapped.map(deepUnwrapSecrets);
  if (unwrapped !== null && typeof unwrapped === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(unwrapped)) {
      result[key] = deepUnwrapSecrets(item);
    }
    return result;
  }
  return unwrapped;
}

/**
 * Resolves a `${}` dot-path against a scope, in the engine's failure mode: interpolation cannot
 * carry on past an unresolvable path, so this throws where the condition evaluator records a trace
 * leaf. The walk itself is @path/schema's — one implementation, one error vocabulary, whether the
 * path came from a placeholder or a predicate.
 *
 * Secrets are unwrapped on the way out (format §8.3): a wrapper may sit at any depth inside the
 * resolved value, and a worker must see real values regardless of how the path addressed them.
 */
export function resolveDotPath(scope: InterpolationScope, path: string): JsonValue {
  const resolved = resolvePath(scope, path);
  if (!resolved.found) throw new InterpolationError(`cannot resolve "${path}": ${resolved.error}`);
  return deepUnwrapSecrets(resolved.value);
}

// A string that is *exactly* one placeholder gets the referenced value's real type (the
// whole-string typing rule); anything else is a splice where every part stringifies.
function wholeStringPlaceholderPath(value: string): string | null {
  if (!value.startsWith("${") || !value.endsWith("}")) return null;
  const inner = value.slice(2, -1);
  if (inner.includes("}")) return null; // more than one placeholder / trailing text after one
  return inner;
}

export function interpolateString(value: string, scope: InterpolationScope): JsonValue {
  const wholePath = wholeStringPlaceholderPath(value);
  if (wholePath !== null) {
    return resolveDotPath(scope, wholePath);
  }

  // The grammar is @path/schema's (tokenizeInterpolation); this only decides what each token
  // becomes. An `unclosed` token used to be unreachable *by assumption* — load-time validation had
  // rejected it — but nothing enforced that a string reached here only via a validated workflow
  // file, so an unvalidated one produced a silently truncated result. Now it is a token, and an
  // error.
  let result = "";
  for (const token of tokenizeInterpolation(value)) {
    switch (token.kind) {
      case "literal":
        result += token.text;
        break;
      case "escape":
        result += "${";
        break;
      case "placeholder": {
        const resolved = resolveDotPath(scope, token.path);
        if (resolved !== null && typeof resolved === "object") {
          throw new InterpolationError(`cannot splice a non-scalar value at "\${${token.path}}" into "${value}"`);
        }
        result += resolved === null ? "null" : String(resolved);
        break;
      }
      case "unclosed":
        throw new InterpolationError(`unclosed placeholder starting at index ${token.index} in "${value}"`);
    }
  }
  return result;
}

// Positions like `command`/`cwd`/`args` (format doc §5) must end up as strings even though the
// whole-string typing rule could otherwise hand back a number/boolean — stringify scalars the
// same way splicing does; a non-scalar there can never be a sensible command/path.
export function interpolateToString(value: string, scope: InterpolationScope): string {
  const resolved = interpolateString(value, scope);
  if (typeof resolved === "string") return resolved;
  if (resolved === null || typeof resolved === "object") {
    throw new InterpolationError(`expected a string value at "${value}", got ${resolved === null ? "null" : "a non-scalar"}`);
  }
  return String(resolved);
}

/** Recursively interpolates every string leaf of a JSON value; other leaves pass through. */
export function interpolateValue(value: JsonValue, scope: InterpolationScope): JsonValue {
  if (typeof value === "string") return interpolateString(value, scope);
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, scope));
  if (value !== null && typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = interpolateValue(item, scope);
    }
    return result;
  }
  return value;
}
