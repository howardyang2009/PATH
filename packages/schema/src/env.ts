import type { EnvWrapper } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import { hasOnlyKey, isPlainObject, mapWrappers } from "./wrapper.js";

/** What `{"$env": "<NAME>"}` *is* (docs/format/workflow-format.md §7.3): it may sit at any depth, including
 * inside `$secret`, which sources a value *and* marks it for redaction. No environment is read here. */

/** True when `$env` is the object's only key, regardless of what the key holds. */
export function hasOnlyEnvKey(value: object): value is Record<"$env", JsonValue> {
  return hasOnlyKey(value, "$env");
}

/** True for a well-formed wrapper; a multi-key object merely carrying `$env` is a plain object. */
export function isEnvWrapper(value: unknown): value is EnvWrapper {
  return isPlainObject(value) && hasOnlyEnvKey(value) && typeof value.$env === "string";
}

/** Deep-walks a value and replaces every `$env` wrapper with `visit(name, path)`. A `$secret` wrapper
 * is walked *through* without becoming a path segment, so the marking annotates the value's own path. */
export function mapEnv(
  value: JsonValue,
  visit: (name: string, path: string) => JsonValue,
  basePath = "",
): JsonValue {
  return mapWrappers(
    value,
    (node, path) => {
      if (isEnvWrapper(node)) return visit(node.$env, path);
      if (isPlainObject(node) && hasOnlyKey(node, "$secret"))
        return { $secret: mapEnv(node.$secret, visit, path) };
      return undefined;
    },
    basePath,
  );
}
