import { describe, expect, it } from "vitest";
import type { WireStepPlugin } from "@path/client-core";
import { PUBLISH_ROOTS, STEP_ROOTS, type WorkflowNode } from "@path/schema";
import {
  validRowsToMap,
  validateInputDraft,
  validateJsonPayload,
  validateMaxIterations,
} from "../src/validated-draft.js";

/**
 * The draft → validate → commit rule, tested at the pure validators — the invariant is "an invalid draft
 * is never committed", once, off the pane's render path (before, it was reachable only through a render
 * of five separate field components).
 */

const UUID = "aaaaaaaa-1111-4111-8111-111111111111";
const plugins: WireStepPlugin[] = [
  { name: "api-call", fields: { endpoint: { type: "string", optional: false } }, workers: ["http"], default_worker: "http" },
];

function apiNode(extra: Record<string, unknown> = {}): WorkflowNode {
  return { id: UUID, name: "call", type: "api-call", endpoint: "/v1", ...extra } as unknown as WorkflowNode;
}
function asRec(node: WorkflowNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

describe("validateJsonPayload", () => {
  it("rejects unparseable JSON without committing", () => {
    const r = validateJsonPayload(apiNode(), "{ not json", plugins);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Not valid JSON/);
  });

  it("rejects a non-object payload", () => {
    const r = validateJsonPayload(apiNode(), "[1, 2]", plugins);
    expect(r).toEqual({ ok: false, error: "The payload must be a JSON object." });
  });

  it("commits a valid payload, merged onto the node's envelope", () => {
    const r = validateJsonPayload(apiNode(), '{"endpoint":"/v2"}', plugins);
    expect(r.ok).toBe(true);
    if (r.ok) expect(asRec(r.value)).toEqual({ id: UUID, name: "call", type: "api-call", endpoint: "/v2" });
  });

  it("rejects a payload whose merged node fails the registry (an unknown step type)", () => {
    const ghost = { id: UUID, name: "g", type: "ghost" } as unknown as WorkflowNode;
    expect(validateJsonPayload(ghost, '{"x":1}', plugins).ok).toBe(false);
  });
});

describe("validateInputDraft", () => {
  it("keeps a populated interpolable object", () => {
    const r = validateInputDraft(apiNode(), '{"a":"${context.x}"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(asRec(r.value).input).toEqual({ a: "${context.x}" });
  });

  it("drops the input key for an empty object or empty draft", () => {
    const withInput = apiNode({ input: { a: 1 } });
    expect("input" in asRec(pickValue(validateInputDraft(withInput, "{}")))).toBe(false);
    expect("input" in asRec(pickValue(validateInputDraft(withInput, "")))).toBe(false);
  });

  it("rejects an ill-typed placeholder without committing", () => {
    expect(validateInputDraft(apiNode(), '{"a":"${context.x"}').ok).toBe(false);
  });
});

describe("validateMaxIterations", () => {
  it("accepts a positive whole number as a number", () => {
    expect(validateMaxIterations("5")).toEqual({ ok: true, value: 5 });
  });

  it("accepts a ${config.…} reference as a string", () => {
    expect(validateMaxIterations("${config.max_revisions}")).toEqual({ ok: true, value: "${config.max_revisions}" });
  });

  it("rejects an empty draft, a zero, and an ill-typed reference", () => {
    expect(validateMaxIterations("").ok).toBe(false);
    expect(validateMaxIterations("0").ok).toBe(false);
    expect(validateMaxIterations("${config.x").ok).toBe(false);
  });
});

describe("validRowsToMap", () => {
  it("builds the map when every named row's value interpolates", () => {
    expect(validRowsToMap([{ key: "out", value: "${output.x}" }], PUBLISH_ROOTS)).toEqual({ ok: true, map: { out: "${output.x}" } });
  });

  it("reports not-ok when a named row's value is ill-typed", () => {
    expect(validRowsToMap([{ key: "out", value: "${output.x" }], PUBLISH_ROOTS)).toEqual({ ok: false });
  });

  it("skips an unnamed (blank-key) in-progress row rather than failing it", () => {
    expect(validRowsToMap([{ key: "", value: "${output.x" }], PUBLISH_ROOTS)).toEqual({ ok: true, map: {} });
  });

  it("honours the roots it is given (output is not a step root)", () => {
    expect(validRowsToMap([{ key: "k", value: "${output.x}" }], STEP_ROOTS)).toEqual({ ok: false });
  });
});

/** Unwrap an ok result's value for a terser assertion; throws (failing the test) if it was not ok. */
function pickValue(result: ReturnType<typeof validateInputDraft>): WorkflowNode {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}
