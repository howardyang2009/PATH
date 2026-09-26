import { type ConfigValue, type EnvWrapper, isEnvWrapper, isSecretWrapper } from "@path/schema";

/** The pure algebra of a config value's shape — a plain scalar, `$env`, `$secret`, or composed
 * `{"$secret": {"$env": …}}` — owning the mode reads **and** the transitions; the pane renders the controls. */

/** True when a config value is a plain scalar the pane can edit with a typed control (not a wrapper/nested). */
export function isEditableScalar(value: ConfigValue): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export type ConfigMode = "literal" | "env" | "secret";

export function configModeOf(value: ConfigValue): ConfigMode {
  if (isSecretWrapper(value)) return "secret";
  if (isEnvWrapper(value)) return "env";
  return "literal";
}

/**
 * The `$env` variable name carried anywhere in a value (bare `$env`, or an env-sourced `$secret`), for mode-switch
 * reuse.
 */
export function envNameOf(value: ConfigValue): string {
  if (isEnvWrapper(value)) return value.$env;
  if (isSecretWrapper(value) && isEnvWrapper(value.$secret)) return value.$secret.$env;
  return "";
}

/** A wrapper's reference-only label (never a resolved value); `null` for a plain scalar. */
export function referenceLabel(value: ConfigValue): string | null {
  if (isSecretWrapper(value)) {
    return isEnvWrapper(value.$secret)
      ? `$secret · $env · ${value.$secret.$env}`
      : "$secret · ••••••";
  }
  if (isEnvWrapper(value)) return `$env · ${value.$env}`;
  return null;
}

/**
 * A config value for read-only display (an inherited ghost): a wrapper as its reference-only label, a scalar as
 * itself, else compact JSON.
 */
export function renderConfigValue(value: ConfigValue): string {
  const reference = referenceLabel(value);
  if (reference !== null) return reference;
  if (isEditableScalar(value)) return String(value);
  return JSON.stringify(value);
}

/** The value from switching to `mode`, preserving the `$env` name so a literal → `$env` → `$secret` walk
 * keeps the name the author typed; `secret` composes `{"$secret": {"$env": name}}` when a name is known. */
export function setConfigMode(value: ConfigValue, mode: ConfigMode): ConfigValue {
  if (mode === "literal") return "";
  if (mode === "env") return { $env: envNameOf(value) };
  return { $secret: envNameOf(value) === "" ? "" : { $env: envNameOf(value) } };
}

/** The value from switching a `$secret`'s source between a literal and an env-sourced one, preserving the
 * `$env` name; `env` composes `{"$secret": {"$env": name}}`, `literal` collapses to `{"$secret": ""}`. */
export function setSecretSource(value: ConfigValue, source: "literal" | "env"): ConfigValue {
  const inner: string | EnvWrapper = isSecretWrapper(value) ? value.$secret : "";
  if (source === "env") return { $secret: { $env: isEnvWrapper(inner) ? inner.$env : "" } };
  return { $secret: "" };
}
