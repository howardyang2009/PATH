import { describe, expect, it } from "vitest";
import { kindExplanation, leafChip, nodeHue } from "../src/node-kind.js";

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
