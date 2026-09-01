import { FORMAT_VERSION, STEP_ROOTS, type WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import { parseInputDraft, referenceablePaths } from "../src/interp-suggest.js";

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

function file(): WorkflowFile {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    config: { model: "gpt", region: "eu" },
    body: [
      { type: "prompt", id: uuid(2), name: "a", prompt: "x", publish: { score: "${output.score}" } } as never,
      { type: "prompt", id: uuid(3), name: "b", prompt: "y", publish: { verdict: "${output.v}" } } as never,
    ],
  };
}

describe("#370 referenceablePaths", () => {
  it("offers config keys, published context keys, and each root prefix for a step's input", () => {
    const paths = referenceablePaths(file(), STEP_ROOTS);
    expect(paths).toContain("config.");
    expect(paths).toContain("context.");
    expect(paths).toContain("config.model");
    expect(paths).toContain("config.region");
    expect(paths).toContain("context.score");
    expect(paths).toContain("context.verdict");
    // A step's input may not read `output` (it does not exist yet), so no output prefix.
    expect(paths).not.toContain("output.");
  });
});

describe("#370 parseInputDraft", () => {
  it("accepts an object with valid placeholders", () => {
    const result = parseInputDraft('{ "q": "${context.score}", "n": 3 }', STEP_ROOTS);
    expect(result).toEqual({ ok: true, value: { q: "${context.score}", n: 3 } });
  });

  it("rejects non-JSON, a non-object, an unclosed placeholder, and an illegal root", () => {
    expect(parseInputDraft("{ not json", STEP_ROOTS).ok).toBe(false);
    expect(parseInputDraft("[1, 2]", STEP_ROOTS).ok).toBe(false);
    expect(parseInputDraft('{ "x": "${context.a" }', STEP_ROOTS).ok).toBe(false);
    // `output` is not a legal input root.
    expect(parseInputDraft('{ "x": "${output.a}" }', STEP_ROOTS).ok).toBe(false);
  });
});
