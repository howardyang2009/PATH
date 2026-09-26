import type { ConfigObject } from "@path/schema";

// Shallow merge per top-level key, override wins (format doc §8): `step config > enclosing workflow's
// effective config > file's own`; operator launch values override the file the same way.
export function mergeConfig(base: ConfigObject, override: ConfigObject | undefined): ConfigObject {
  if (!override) return { ...base };
  return { ...base, ...override };
}
