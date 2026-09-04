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

  it("accepts any JSON value: a literal and an array (§6.1)", () => {
    expect(parseInputDraft("3", STEP_ROOTS)).toEqual({ ok: true, value: 3 });
    expect(parseInputDraft('["${context.a}", 2]', STEP_ROOTS)).toEqual({ ok: true, value: ["${context.a}", 2] });
  });

  it("accepts a whole-string interpolation authored raw, without JSON quotes (§6.1/§6.6)", () => {
    expect(parseInputDraft("${context.final_notes}", STEP_ROOTS)).toEqual({ ok: true, value: "${context.final_notes}" });
    // The quoted form parses as the same string.
    expect(parseInputDraft('"${context.final_notes}"', STEP_ROOTS)).toEqual({ ok: true, value: "${context.final_notes}" });
  });

  it("rejects malformed JSON, an unclosed placeholder, and an illegal root", () => {
    // Starts with `{`, so it is taken as structured JSON and its parse error is reported.
    expect(parseInputDraft("{ not json", STEP_ROOTS).ok).toBe(false);
    expect(parseInputDraft('{ "x": "${context.a" }', STEP_ROOTS).ok).toBe(false);
    // `output` is not a legal input root — checked at every string leaf, raw whole-string included.
    expect(parseInputDraft('{ "x": "${output.a}" }', STEP_ROOTS).ok).toBe(false);
    expect(parseInputDraft("${output.a}", STEP_ROOTS).ok).toBe(false);
    expect(parseInputDraft("${context.a", STEP_ROOTS).ok).toBe(false);
  });
});
