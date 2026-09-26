import type { ConfigObject, ConfigValue } from "@path/schema";
import { withoutKey } from "./edit-target.js";

/** The pure model behind the config-inheritance region: a step inherits config from the enclosing
 * workflow unless it overrides it, so the pane shows **mine vs inherited** from the file's and node's own
 * `config` alone (the wire registry carries no config fragment). `type` is author-fixed and never inherits. */

export type ConfigOrigin = "inherited" | "overridden" | "local";

export interface ConfigRow {
  key: string;
  value: ConfigValue;
  origin: ConfigOrigin;
}

/** The config rows a node shows, merging the file's inheritable keys with the node's own; `hide` drops
 * keys a first-class editor already owns, so the two regions stay distinct. Rows are sorted by key. */
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
    const inNode = Object.hasOwn(node, key);
    const inFile = Object.hasOwn(file, key);
    if (inNode) {
      rows.push({ key, value: node[key]!, origin: inFile ? "overridden" : "local" });
    } else {
      rows.push({ key, value: file[key]!, origin: "inherited" });
    }
  }
  return rows;
}

/** Set (or add) a local config key on a node's config, returning a new config object. */
export function setConfigKey(
  config: ConfigObject | undefined,
  key: string,
  value: ConfigValue,
): ConfigObject {
  return { ...(config ?? {}), [key]: value };
}

/** Drop a local config key — `undefined` when that empties it, so no bare `config: {}` is ever written. */
export function dropConfigKey(
  config: ConfigObject | undefined,
  key: string,
): ConfigObject | undefined {
  const rest = withoutKey(config ?? {}, key);
  return Object.keys(rest).length === 0 ? undefined : rest;
}
