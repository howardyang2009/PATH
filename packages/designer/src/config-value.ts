import { isEnvWrapper, isSecretWrapper, type ConfigValue, type EnvWrapper } from "@path/schema";

/**
 * The pure algebra of a single **config value's shape** in the properties pane (#370, designer-spec
 * § `$env` / `$secret` authoring, map decision 9). A config value is a plain scalar, an `$env` wrapper,
 * a `$secret` wrapper, or a composed `{"$secret": {"$env": …}}`. This module owns the reads (which mode
 * a value is in, its reference-only label) **and** the mode transitions (switching a value between
 * literal / `$env` / `$secret`, and a `$secret`'s source between a literal and an `$env`). The pane
 * renders the controls; the value construction lives here, where it is unit-testable.
 *
 * It sits *below* `config-inheritance.ts`: inheritance is a layer over a value, so the shared
 * `isEditableScalar` guard lives here and `config-inheritance.ts` imports it, never the reverse.
 */

/** True when a config value is a plain scalar the pane can edit with a typed control (not a wrapper/nested). */
export function isEditableScalar(value: ConfigValue): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** The three authoring modes a config value takes in the pane (§ `$env` / `$secret` authoring, map decision 9). */
export type ConfigMode = "literal" | "env" | "secret";

/** Which mode a config value is in, read off its shape: a `$secret` wrapper, an `$env` wrapper, or a plain literal. */
export function configModeOf(value: ConfigValue): ConfigMode {
  if (isSecretWrapper(value)) return "secret";
  if (isEnvWrapper(value)) return "env";
  return "literal";
}

/** The `$env` variable name carried anywhere in a value (bare `$env`, or an env-sourced `$secret`), for mode-switch reuse. */
export function envNameOf(value: ConfigValue): string {
  if (isEnvWrapper(value)) return value.$env;
  if (isSecretWrapper(value) && isEnvWrapper(value.$secret)) return value.$secret.$env;
  return "";
}

/**
 * The reference-only label of a wrapper — never a resolved value (§ Display is reference-only). An `$env`
 * shows its variable name; a `$secret` shows a masked, named token (the env name when sourced from `$env`,
 * masked bullets for a literal secret). A plain scalar or nested value returns `null` (it is not a reference).
 */
export function referenceLabel(value: ConfigValue): string | null {
  if (isSecretWrapper(value)) {
    return isEnvWrapper(value.$secret) ? `$secret · $env · ${value.$secret.$env}` : "$secret · ••••••";
  }
  if (isEnvWrapper(value)) return `$env · ${value.$env}`;
  return null;
}

/** A config value for read-only display (an inherited ghost): a wrapper as its reference-only label, a scalar as itself, else compact JSON. */
export function renderConfigValue(value: ConfigValue): string {
  const reference = referenceLabel(value);
  if (reference !== null) return reference;
  if (isEditableScalar(value)) return String(value);
  return JSON.stringify(value);
}

/**
 * The value that results from switching a config value to `mode`, preserving the `$env` name across the
 * switch so a literal → `$env` → `$secret` walk keeps the name the author typed. `literal` clears to an
 * empty string; `secret` composes `{"$secret": {"$env": name}}` when a name is known, else a bare literal
 * secret. The pane guards against a no-op switch (`mode` already current) before calling this.
 */
export function setConfigMode(value: ConfigValue, mode: ConfigMode): ConfigValue {
  if (mode === "literal") return "";
  if (mode === "env") return { $env: envNameOf(value) };
  return { $secret: envNameOf(value) === "" ? "" : { $env: envNameOf(value) } };
}

/**
 * The value that results from switching a `$secret`'s source between a literal secret and an env-sourced
 * one, preserving the `$env` name across the switch. `env` composes `{"$secret": {"$env": name}}`;
 * `literal` collapses to `{"$secret": ""}`.
 */
export function setSecretSource(value: ConfigValue, source: "literal" | "env"): ConfigValue {
  const inner: string | EnvWrapper = isSecretWrapper(value) ? value.$secret : "";
  if (source === "env") return { $secret: { $env: isEnvWrapper(inner) ? inner.$env : "" } };
  return { $secret: "" };
}
