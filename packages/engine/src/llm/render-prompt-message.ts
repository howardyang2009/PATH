import type { JsonValue } from "@path/schema";

/**
 * Renders one `prompt` step into the single message its processor receives: the instruction text
 * plus the step's *entire* input object (workflow-format-v0.md §4.2). There is no `context_refs`
 * mechanism — what the step reads is exactly what its `input` map built, so the whole object is
 * rendered rather than selectively summarized.
 *
 * A string input is rendered raw and anything else as JSON, the same split the binary step makes
 * when writing its input to stdin (§4.2), so both step types treat an input object alike.
 */
export function renderPromptMessage(prompt: string, input: JsonValue): string {
  const rendered = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return `${prompt}\n\nInput object:\n${rendered}`;
}
