import { describe, expect, it } from "vitest";
import { renderPromptMessage } from "../../src/llm/render-prompt-message.js";

describe("render-prompt-message", () => {
  it("puts the instruction text first, then the step's whole input object", () => {
    const message = renderPromptMessage("Summarize the release.", { version: "1.2.0", commits: 7 });

    expect(message).toBe('Summarize the release.\n\nInput object:\n{\n  "version": "1.2.0",\n  "commits": 7\n}');
  });

  it("renders a string input raw, mirroring the binary step's stdin convention (format doc §4.2)", () => {
    const message = renderPromptMessage("Translate this.", "guten tag");

    expect(message).toBe("Translate this.\n\nInput object:\nguten tag");
  });

  it("still renders an empty input object — what the step reads is exactly what its input map built", () => {
    expect(renderPromptMessage("Say hi.", {})).toBe("Say hi.\n\nInput object:\n{}");
  });

  it("renders non-object inputs (the default-input chain can carry any JSON value)", () => {
    expect(renderPromptMessage("Double it.", 21)).toBe("Double it.\n\nInput object:\n21");
    expect(renderPromptMessage("Check it.", null)).toBe("Check it.\n\nInput object:\nnull");
    expect(renderPromptMessage("List it.", [1, 2])).toBe("List it.\n\nInput object:\n[\n  1,\n  2\n]");
  });
});
