import type { ConfigObject } from "@path/schema";

/**
 * Shallow merge per top-level key, override wins (format doc §8): `step config > enclosing
 * workflow's effective config > file's own config (defaults)`, and operator launch-time values
 * override the top-level file's defaults the same way (spec §3).
 */
export function mergeConfig(base: ConfigObject, override: ConfigObject | undefined): ConfigObject {
  if (!override) return { ...base };
  return { ...base, ...override };
}
