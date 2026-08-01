import type { SecretWrapper } from "./config-value-type.js";
import { isEnvWrapper } from "./env.js";
import type { JsonValue } from "./json-value.js";
import { hasOnlyKey, isPlainObject, mapWrappers } from "./wrapper.js";

/**
 * What a `{"$secret": "<value>"}` config value *is* (workflow-format-v0.md §8.3), in one place:
 * the shape, and the fact that one may sit at any depth inside a config value.
 *
 * Both readers of a secret are policies over this walk rather than walks of their own — the engine
 * unwraps them for the worker (`interpolate.ts`) and collects them for the masker
 * (`secret-mask.ts`). They used to spell the predicate identically under two names and walk the
 * structure twice, in two modules, neither importing the schema that already defined the shape;
 * secrecy is an invariant, so the two could disagree about where a wrapper may sit and nothing
 * would say so.
 */

/**
 * True when `$secret` is the object's only key — the sole-key rule on its own, regardless of what
 * the key holds. `@path/schema`-internal: it exists so `ConfigValueSchema` can reject a sole-key
 * `$secret` object whose value is not well-formed rather than letting it pass as an ordinary object
 * with an oddly-named key.
 */
export function hasOnlySecretKey(value: object): value is Record<"$secret", JsonValue> {
  return hasOnlyKey(value, "$secret");
}

/**
 * True when the value is a well-formed wrapper. A multi-key object that merely happens to carry a
 * `$secret` key is a plain object, not a wrapper.
 *
 * The value is a literal secret or an `{"$env": "NAME"}` wrapper naming where to source one — the
 * composed form, which `env.ts` resolves before this walk ever runs.
 */
export function isSecretWrapper(value: unknown): value is SecretWrapper {
  if (!isPlainObject(value) || !hasOnlySecretKey(value)) return false;
  return typeof value.$secret === "string" || isEnvWrapper(value.$secret);
}

/**
 * Deep-walks a value and replaces every `$secret` wrapper in it with whatever `visit` returns for
 * that secret, leaving every other leaf untouched. `path` is the dot-path the wrapper was found
 * under, extended from `basePath` with object keys and array indices as segments. Where a wrapper
 * may sit is `wrapper.ts`'s descent, shared with `mapEnv`; this states only what to do on reaching
 * one.
 *
 * The wrapper's own string is not walked into — it is the secret, not more structure.
 *
 * A wrapper still holding an unresolved `{"$env": "NAME"}` is handed back as it stands: there is no
 * secret value yet to unwrap or collect, and this walk will not invent one. `env.ts`'s resolution
 * runs first (map #113) precisely so that the masker collects the *resolved* token rather than a
 * variable name — so an unresolved wrapper reaching here means that step was skipped, and what a
 * worker then receives is the wrapper shape either way. Claiming it keeps the two walks agreeing
 * that a composed wrapper is one wrapper, not a plain object with an odd key.
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
      return typeof node.$secret === "string" ? visit(node.$secret, path) : (node as unknown as JsonValue);
    },
    basePath,
  );
}
