import { describe, expect, it } from "vitest";
import { parseJsonField } from "../src/launch-json.js";

/**
 * The launch form's client-side JSON gate (issue #233, variant A). Pure and exhaustive here so the
 * component test can stay about wiring, not about every empty/parse/shape case. The server stays the
 * real validator (a rejected `$env` config is left to it, ADR 0012); this only catches what is not
 * even valid JSON, or not the object the wire declares (`input` is `record`, `config` is
 * `ConfigObject`), before a request is spent.
 */
describe("parseJsonField", () => {
  it("accepts a parsed object and returns its value", () => {
    const r = parseJsonField('{"ticket": 42}', { allowEmpty: true });
    expect(r).toEqual({ ok: true, empty: false, value: { ticket: 42 } });
  });

  it("treats blank text as an omitted field when empty is allowed", () => {
    expect(parseJsonField("   ", { allowEmpty: true })).toEqual({ ok: true, empty: true, value: undefined });
  });

  it("rejects blank text when empty is not allowed", () => {
    const r = parseJsonField("", { allowEmpty: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/required/i);
  });

  it("rejects text that is not valid JSON, surfacing the parser message", () => {
    const r = parseJsonField("{ not json", { allowEmpty: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });

  it("rejects valid JSON that is not an object (the wire declares a record)", () => {
    for (const text of ["[1, 2]", '"a string"', "42", "true", "null"]) {
      const r = parseJsonField(text, { allowEmpty: true });
      expect(r.ok, `${text} should be rejected`).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/object/i);
    }
  });

  it("accepts an empty object", () => {
    expect(parseJsonField("{}", { allowEmpty: true })).toEqual({ ok: true, empty: false, value: {} });
  });
});
