import type { ConfigObject, ConfigValue } from "@path/schema";

/**
 * The pure model behind the config-inheritance region of the properties pane (#370, designer-spec
 * § Config inheritance display, invariant 5). A step inherits config downward from the enclosing
 * workflow unless it overrides it; the editor must let the author tell **mine from inherited without
 * reading the parent**. This module derives that distinction from data alone — the file's own `config`
 * and the node's own `config` — so the pane never needs the registry's config fragment (which the wire
 * registry does not carry) to render inherited-vs-overridden.
 *
 * - **inherited** — a key the file declares that the node does not: read-only, ghosted, captioned with
 *   its origin (`inherited from <workflow name>`).
 * - **overridden** — a key the node declares that the file also declares: solid, with a revert control
 *   that drops the local value and restores the inherited one.
 * - **local** — a key the node declares that the file does not: solid, with nothing to revert to.
 *
 * The `type` field (`command` / `prompt` / `endpoint`) is author-fixed and does **not** inherit
 * (ADR 0022); it edits in a distinct pane region (the kind fields) and never appears here.
 */

export type ConfigOrigin = "inherited" | "overridden" | "local";

export interface ConfigRow {
  key: string;
  value: ConfigValue;
  origin: ConfigOrigin;
}

/**
 * The config rows a node shows, merging the file's inheritable keys with the node's own. `hide` drops
 * keys a first-class editor already owns (a `prompt`'s `model` edits as its own Model field, #369), so
 * the two regions stay distinct. Rows are sorted by key for a stable render.
 */
export function configRows(
  fileConfig: ConfigObject | undefined,
  nodeConfig: ConfigObject | undefined,
  hide: ReadonlySet<string> = new Set(),
): ConfigRow[] {
  const file = fileConfig ?? {};
  const node = nodeConfig ?? {};
  const keys = new Set<string>([...Object.keys(file), ...Object.keys(node)]);
  const rows: ConfigRow[] = [];
  for (const key of [...keys].sort()) {
    if (hide.has(key)) continue;
    const inNode = Object.prototype.hasOwnProperty.call(node, key);
    const inFile = Object.prototype.hasOwnProperty.call(file, key);
    if (inNode) {
      rows.push({ key, value: node[key]!, origin: inFile ? "overridden" : "local" });
    } else {
      rows.push({ key, value: file[key]!, origin: "inherited" });
    }
  }
  return rows;
}

/** Set (or add) a local config key on a node's config, returning a new config object. */
export function setConfigKey(config: ConfigObject | undefined, key: string, value: ConfigValue): ConfigObject {
  return { ...(config ?? {}), [key]: value };
}

/**
 * Drop a local config key, returning the new config — or `undefined` when that empties it, so the node
 * can drop the whole `config` field (an empty `config: {}` is noise the author never wrote).
 */
export function dropConfigKey(config: ConfigObject | undefined, key: string): ConfigObject | undefined {
  const { [key]: _dropped, ...rest } = config ?? {};
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/** True when a config value is a plain scalar the pane can edit with a typed control (not a wrapper/nested). */
export function isEditableScalar(value: ConfigValue): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
