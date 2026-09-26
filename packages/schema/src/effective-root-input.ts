import type { JsonValue } from "./json-value.js";

/**
 * The **root input** a launch actually sends: a non-empty operator override wins, else the file's own
 * top-level `input` seed, else `{}` (format `@4` §1a). An override is empty when it is absent or an
 * empty object, so `{}` is "no override" too.
 *
 * This is one rule with several launch doors — `path run`'s `--context`/`--set-context`, and
 * `POST /v0/runs`, which the Viewer panel and the Designer's run dock reach through. It lives in
 * `@path/schema` because that is where the doors' shared rules live (beside `identityIssues` and
 * `validateLaunchWorkerDefaults`), so no door can resolve the fallback its own way and drift. The file
 * seed is the workflow's own default; what a run records and freezes is the *resolved* effective
 * input, never the default it may have fallen back to (ADR 0046).
 */
export function effectiveRootInput(
  override: { [key: string]: JsonValue } | undefined,
  fileInput: { [key: string]: JsonValue } | undefined,
): { [key: string]: JsonValue } {
  if (override !== undefined && Object.keys(override).length > 0) return override;
  return fileInput ?? {};
}

/**
 * Both halves of a launch's input, as every launch door hands them to the engine: `input`, the
 * effective seed the root context starts from (`effectiveRootInput`), and `operatorInput`, the override
 * as the operator sent it, recorded beside it as a launch fact (ADR 0046). An empty override is no
 * override, so `operatorInput` is then absent — the same rule `input` applies.
 */
export function launchInput(
  override: { [key: string]: JsonValue } | undefined,
  fileInput: { [key: string]: JsonValue } | undefined,
): { input: { [key: string]: JsonValue }; operatorInput: { [key: string]: JsonValue } | undefined } {
  const input = effectiveRootInput(override, fileInput);
  return { input, operatorInput: override !== undefined && Object.keys(override).length > 0 ? override : undefined };
}
