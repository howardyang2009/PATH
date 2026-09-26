import type { JsonValue } from "./json-value.js";

/** The root input a launch sends: a non-empty operator override wins, else the file's top-level
 * `input`, else `{}` (format `@4` §1a). One rule for every launch door; a run records the resolved input. */
export function effectiveRootInput(
  override: { [key: string]: JsonValue } | undefined,
  fileInput: { [key: string]: JsonValue } | undefined,
): { [key: string]: JsonValue } {
  if (override !== undefined && Object.keys(override).length > 0) return override;
  return fileInput ?? {};
}

/** Both halves of a launch's input: `input`, the effective seed, and `operatorInput`, the override as
 * sent, recorded beside it as a launch fact (ADR 0046). An empty override means no `operatorInput`. */
export function launchInput(
  override: { [key: string]: JsonValue } | undefined,
  fileInput: { [key: string]: JsonValue } | undefined,
): {
  input: { [key: string]: JsonValue };
  operatorInput: { [key: string]: JsonValue } | undefined;
} {
  const input = effectiveRootInput(override, fileInput);
  return {
    input,
    operatorInput:
      override !== undefined && Object.keys(override).length > 0 ? override : undefined,
  };
}
