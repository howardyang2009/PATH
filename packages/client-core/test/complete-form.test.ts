import type { JsonValue } from "@path/schema";
import { describe, expect, it } from "vitest";
import {
  buildCompleteFields,
  coerceCompleteOutput,
  coerceRawCompleteOutput,
  mapCompleteErrors,
  validateCompleteDraft,
} from "../src/complete-form.js";

const schema: JsonValue = {
  type: "object",
  required: ["approved", "reviewer", "riskLevel"],
  properties: {
    approved: { type: "boolean", title: "Approved", description: "Tick if cleared." },
    reviewer: { type: "string", title: "Reviewer name" },
    riskLevel: { type: "string", title: "Risk level", enum: ["low", "medium", "high"] },
    amount: { type: "number", title: "Amount" },
    notes: { type: "string", title: "Notes", format: "textarea" },
  },
};

describe("buildCompleteFields", () => {
  it("returns one field per property, in order, typed by the schema", () => {
    const fields = buildCompleteFields(schema);
    expect(fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["approved", "boolean", true],
      ["reviewer", "string", true],
      ["riskLevel", "enum", true],
      ["amount", "number", false],
      ["notes", "string", false],
    ]);
    expect(fields[2]!.enum).toEqual(["low", "medium", "high"]);
    expect(fields[4]!.multiline).toBe(true);
    expect(fields[0]!.title).toBe("Approved");
    expect(fields[0]!.description).toBe("Tick if cleared.");
    // A property with no title falls back to its key.
    expect(fields[3]!.title).toBe("Amount");
  });

  it("returns no fields for a null schema (any JSON accepted)", () => {
    expect(buildCompleteFields(null)).toEqual([]);
  });
});

describe("coerceRawCompleteOutput", () => {
  it("treats blank text as an empty output (the historical bare submit)", () => {
    expect(coerceRawCompleteOutput("")).toEqual({});
    expect(coerceRawCompleteOutput("   \n ")).toEqual({});
  });

  it("parses any JSON value: object, quoted string, number, array", () => {
    expect(coerceRawCompleteOutput('{ "url": "x" }')).toEqual({ url: "x" });
    expect(coerceRawCompleteOutput('"done"')).toBe("done");
    expect(coerceRawCompleteOutput("42")).toBe(42);
    expect(coerceRawCompleteOutput("[1, 2]")).toEqual([1, 2]);
  });

  it("takes non-JSON text as a plain string, never an error", () => {
    expect(coerceRawCompleteOutput("done")).toBe("done");
    expect(coerceRawCompleteOutput("ship it please")).toBe("ship it please");
    expect(coerceRawCompleteOutput("{ not json")).toBe("{ not json");
    // Surrounding whitespace is trimmed, as it is for the JSON path.
    expect(coerceRawCompleteOutput("  hello  ")).toBe("hello");
  });
});

describe("coerceCompleteOutput", () => {
  it("types values and omits empty non-boolean fields", () => {
    const fields = buildCompleteFields(schema);
    const out = coerceCompleteOutput(fields, {
      approved: true,
      reviewer: "  Dana  ",
      riskLevel: "high",
      amount: "42",
      notes: "",
    });
    expect(out).toEqual({ approved: true, reviewer: "Dana", riskLevel: "high", amount: 42 });
  });

  it("keeps a false boolean but drops a blank number", () => {
    const fields = buildCompleteFields(schema);
    expect(coerceCompleteOutput(fields, { approved: false, amount: "" })).toEqual({ approved: false });
  });
});

describe("validateCompleteDraft", () => {
  it("flags missing required fields and a bad enum, from the route's own validator", () => {
    const fields = buildCompleteFields(schema);
    const out = coerceCompleteOutput(fields, { approved: true, riskLevel: "extreme" });
    const errs = validateCompleteDraft(schema, out);

    expect(errs.fieldErrors.reviewer).toMatch(/required/i);
    expect(errs.fieldErrors.riskLevel).toMatch(/one of/i);
    expect(errs.fieldErrors.approved).toBeUndefined();
  });

  it("flags a non-numeric number field", () => {
    const outputSchema: JsonValue = { type: "object", properties: { amount: { type: "number" } } };
    const out = { amount: Number.NaN } as unknown as JsonValue;

    expect(validateCompleteDraft(outputSchema, out).fieldErrors.amount).toMatch(/number/i);
  });

  it("catches a constraint the form could previously not see — the mirror's whole gap", () => {
    // A `pattern` passed the old pre-check and came back as a `400`; one validator means it cannot.
    const outputSchema: JsonValue = {
      type: "object",
      required: ["code"],
      properties: { code: { type: "string", pattern: "^[A-Z]{3}$" } },
    };

    expect(validateCompleteDraft(outputSchema, { code: "nope" }).fieldErrors.code).toMatch(/pattern/i);
    expect(validateCompleteDraft(outputSchema, { code: "ABC" }).fieldErrors).toEqual({});
  });

  it("checks nothing for a node with no schema, which accepts any JSON (ADR 0040)", () => {
    expect(validateCompleteDraft(null, { anything: true })).toEqual({ fieldErrors: {}, formErrors: [] });
  });

  it("reports an uncompilable schema at the form level rather than throwing", () => {
    const bad: JsonValue = { type: "object", properties: { x: { type: "nonsense" } } };

    expect(validateCompleteDraft(bad, { x: 1 }).formErrors.join(" ")).toMatch(/not a valid JSON Schema/);
  });
});

describe("mapCompleteErrors", () => {
  it("maps ajv required + field issues to their keys, verbatim messages", () => {
    const details: JsonValue = [
      { instancePath: "", keyword: "required", params: { missingProperty: "reviewer" }, message: "must have required property 'reviewer'" },
      { instancePath: "/riskLevel", keyword: "enum", params: { allowedValues: ["low", "medium", "high"] }, message: "must be equal to one of the allowed values" },
    ];
    const mapped = mapCompleteErrors(details);
    expect(mapped.fieldErrors.reviewer).toBe("must have required property 'reviewer'");
    expect(mapped.fieldErrors.riskLevel).toBe("must be equal to one of the allowed values");
    expect(mapped.formErrors).toEqual([]);
  });

  it("routes an unattributable issue to the form level", () => {
    const details: JsonValue = [{ message: "outputSchema is not a valid JSON Schema: …" }];
    const mapped = mapCompleteErrors(details);
    expect(mapped.fieldErrors).toEqual({});
    expect(mapped.formErrors).toEqual(["outputSchema is not a valid JSON Schema: …"]);
  });

  it("returns empty maps for absent or non-array details", () => {
    expect(mapCompleteErrors(undefined)).toEqual({ fieldErrors: {}, formErrors: [] });
    expect(mapCompleteErrors("boom")).toEqual({ fieldErrors: {}, formErrors: [] });
  });
});
