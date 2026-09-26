import {
  type ConfigObject,
  type JsonValue,
  mapSecrets,
  resolveDotPath as resolvePath,
  tokenizeInterpolation,
} from "@path/schema";

/** The `config`/`context`/`output` values a `${dot.path}` resolves against (format doc §5). */
export type InterpolationScope = { [root: string]: JsonValue };

// Thrown rather than returned as a Result: callers catch it and translate it into their own outcome.
export class InterpolationError extends Error {}

/**
 * The scope a node's `${}` expressions resolve against: its effective `config`, the enclosing run's
 * `context`, and — for a `publish` map only — the step's own `output`.
 */
export function interpolationScope(
  config: ConfigObject,
  context: { [key: string]: JsonValue },
  output?: JsonValue,
): InterpolationScope {
  // Structurally compatible but not nominally assignable across the recursive unions.
  const scope: InterpolationScope = { config: config as unknown as JsonValue, context };
  if (output !== undefined) scope.output = output;
  return scope;
}

/**
 * An interpolation failure as a node's failed-outcome message. Any other error is a bug, not a
 * data-flow failure, so it is re-thrown rather than swallowed.
 */
export function describeInterpolationError(nodeName: string, err: unknown): string {
  if (err instanceof InterpolationError) return `node "${nodeName}": ${err.message}`;
  throw err;
}

/** Resolves a `${}` dot-path, throwing where the condition evaluator records a trace leaf. */
export function resolveDotPath(scope: InterpolationScope, path: string): JsonValue {
  const resolved = resolvePath(scope, path);
  if (!resolved.found) throw new InterpolationError(`cannot resolve "${path}": ${resolved.error}`);
  // Secrets are unwrapped on the way out (format §7.3): masking is a persistence-boundary concern,
  // not a dataflow restriction, so a worker must see real values.
  return mapSecrets(resolved.value, (secret) => secret);
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

  // The grammar is @path/schema's (tokenizeInterpolation); this only decides what each token becomes.
  // An `unclosed` token is an error: a string can reach here from an unvalidated workflow file too.
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
          throw new InterpolationError(
            `cannot splice a non-scalar value at "\${${token.path}}" into "${value}"`,
          );
        }
        result += resolved === null ? "null" : String(resolved);
        break;
      }
      case "unclosed":
        throw new InterpolationError(
          `unclosed placeholder starting at index ${token.index} in "${value}"`,
        );
    }
  }
  return result;
}

// Positions like `command`/`cwd`/`args` (format doc §5) must end up as strings even where the
// whole-string typing rule would hand back a number/boolean; a non-scalar can never be a command/path.
export function interpolateToString(value: string, scope: InterpolationScope): string {
  const resolved = interpolateString(value, scope);
  if (typeof resolved === "string") return resolved;
  if (resolved === null || typeof resolved === "object") {
    throw new InterpolationError(
      `expected a string value at "${value}", got ${resolved === null ? "null" : "a non-scalar"}`,
    );
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
