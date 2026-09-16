import { describe, expect, it } from "vitest";
import { kindExplanation, leafChip, leafGlyph, nodeHue } from "../src/node-kind.js";

describe("node-kind descriptor", () => {
  it("gives each control block its own hue and leaf steps the step hue", () => {
    expect(nodeHue("parallel")).toBe("parallel");
    expect(nodeHue("branch")).toBe("branch");
    expect(nodeHue("while-do")).toBe("while");
    expect(nodeHue("sequence")).toBe("sequence");
    expect(nodeHue("checkpoint")).toBe("checkpoint");
    expect(nodeHue("workflow")).toBe("workflow");
    expect(nodeHue("prompt")).toBe("step");
    expect(nodeHue("binary")).toBe("step");
  });

  it("gives person-activity its own teal hue, a person glyph, and a readable chip (#487)", () => {
    // A distinct hue and glyph so it reads apart from a generic `--k-step` leaf and from binary/prompt.
    expect(nodeHue("person-activity")).toBe("person");
    expect(leafGlyph("person-activity")).toBe("👤");
    expect(leafChip("person-activity")).toBe("PERSON");
    expect(kindExplanation("person-activity")).toMatch(/person completes/);
  });

  it("has no glyph for a kind that does not declare one", () => {
    expect(leafGlyph("prompt")).toBe("");
    expect(leafGlyph("binary")).toBe("");
    expect(leafGlyph("api-call")).toBe("");
  });

  it("falls back to the step hue for an unlisted registry type", () => {
    expect(nodeHue("api-call")).toBe("step");
  });

  it("explains each kind and derives an explanation for an unlisted type", () => {
    expect(kindExplanation("while-do")).toMatch(/Repeats one body/);
    expect(kindExplanation("checkpoint")).toMatch(/Asserts a condition/);
    expect(kindExplanation("api-call")).toBe("A api-call step.");
  });

  it("labels a leaf chip by kind, upper-casing an unlisted type", () => {
    expect(leafChip("prompt")).toBe("LLM");
    expect(leafChip("binary")).toBe("COMMAND");
    expect(leafChip("api-call")).toBe("API-CALL");
  });
});
