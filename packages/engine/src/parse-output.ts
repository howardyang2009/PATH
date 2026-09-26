import type { JsonValue } from "@path/schema";

// Thrown rather than returned as a Result: its caller translates it into its own failed outcome.
export class OutputParseError extends Error {}

// A surrounding ```json ... ``` (or bare ``` ... ```) fence is stripped before parsing (format doc §6.5).
const FENCE_PATTERN = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

/** `parse: "json"` (format doc §6.5): unparseable output fails the step. */
export function parseStepOutput(raw: string): JsonValue {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(FENCE_PATTERN);
  const jsonText = fenceMatch ? (fenceMatch[1] ?? "").trim() : trimmed;

  try {
    return JSON.parse(jsonText) as JsonValue;
  } catch (err) {
    throw new OutputParseError(
      `failed to parse output as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
