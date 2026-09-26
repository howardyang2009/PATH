import type { SecretWrapper } from "./config-value-type.js";
import { isEnvWrapper } from "./env.js";
import type { JsonValue } from "./json-value.js";
import { hasOnlyKey, isPlainObject, mapWrappers } from "./wrapper.js";

/**
 * What a `{"$secret": "<value>"}` config value is (docs/format/workflow-format.md §7.3): the shape, and the fact that one may
 * sit at any depth inside a config value.
 */

/**
 * True when `$secret` is the object's only key, whatever it holds — so `ConfigValueSchema` can reject a malformed
 * sole-key `$secret` object.
 */
export function hasOnlySecretKey(value: object): value is Record<"$secret", JsonValue> {
  return hasOnlyKey(value, "$secret");
}

/**
 * True when the value is a well-formed wrapper: `$secret` is the only key and holds a literal secret or an `{"$env":
 * "NAME"}` source wrapper.
 */
export function isSecretWrapper(value: unknown): value is SecretWrapper {
  if (!isPlainObject(value) || !hasOnlySecretKey(value)) return false;
  return typeof value.$secret === "string" || isEnvWrapper(value.$secret);
}

/**
 * Deep-walks `value` replacing every `$secret` wrapper with `visit`'s result; the wrapper's own string is not
 * walked into, and an unresolved `{"$env": "NAME"}` wrapper is handed back as it stands.
 */
export function mapSecrets(
  value: JsonValue,
  visit: (secret: string, path: string) => JsonValue,
  basePath = "",
): JsonValue {
  return mapWrappers(
    value,
    (node, path) => {
      if (!isSecretWrapper(node)) return undefined;
      return typeof node.$secret === "string"
        ? visit(node.$secret, path)
        : (node as unknown as JsonValue);
    },
    basePath,
  );
}
