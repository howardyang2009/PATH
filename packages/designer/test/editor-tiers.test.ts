import type { WireStepPlugin } from "@path/client-core";
import { describe, expect, it } from "vitest";
import { editorTier, fieldsLayOut } from "../src/editor-tiers.js";

const plugins: WireStepPlugin[] = [
  { name: "prompt", fields: { prompt: { type: "string", optional: false } }, workers: ["sdk"], default_worker: "sdk" },
  {
    name: "api-call",
    fields: { endpoint: { type: "string", optional: false }, retries: { type: "number", optional: true } },
    workers: ["http"],
    default_worker: "http",
  },
  { name: "weird", fields: { shape: { type: "object", optional: false } }, workers: ["w"], default_worker: "w" },
  {
    name: "listy",
    fields: { tags: { type: "array", optional: true, element: { type: "string", optional: false } } },
    workers: ["w"],
    default_worker: "w",
  },
];

describe("editorTier — the three-tier resolution", () => {
  it("resolves prompt, binary, and workflow to the hand-built first-class tier", () => {
    expect(editorTier("prompt", plugins)).toBe("first-class");
    expect(editorTier("binary", plugins)).toBe("first-class");
    expect(editorTier("workflow", plugins)).toBe("first-class");
  });

  it("generates a form for a type whose every field lays out (scalars, flat scalar arrays)", () => {
    expect(editorTier("api-call", plugins)).toBe("generic");
    expect(editorTier("listy", plugins)).toBe("generic");
  });

  it("falls to the raw-JSON floor for a type with an unlayoutable field", () => {
    expect(editorTier("weird", plugins)).toBe("raw-json");
  });
});

describe("fieldsLayOut", () => {
  it("is true for scalars and a flat scalar array, false for an object or nested array", () => {
    expect(fieldsLayOut({ a: { type: "string", optional: false }, b: { type: "number", optional: true } })).toBe(true);
    expect(fieldsLayOut({ a: { type: "array", optional: false, element: { type: "boolean", optional: false } } })).toBe(true);
    expect(fieldsLayOut({ a: { type: "record", optional: false } })).toBe(false);
    expect(fieldsLayOut({ a: { type: "array", optional: false, element: { type: "object", optional: false } } })).toBe(false);
  });
});
