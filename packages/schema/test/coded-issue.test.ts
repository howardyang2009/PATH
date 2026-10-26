import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IdSchema, NameSchema } from "../src/ids.js";
import { ConditionSchema, issueMessages, zodIssueMessage } from "../src/index.js";

function firstIssue(schema: z.ZodType, value: unknown): z.core.$ZodIssue {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected a parse failure");
  return result.error.issues[0]!;
}

describe("zodIssueMessage", () => {
  it("maps a PATH refinement to its errors.<code> message", () => {
    const issue = firstIssue(ConditionSchema, { type: "range", path: "previous.n" });
    expect(zodIssueMessage(issue)).toEqual({ key: "errors.schema.condition.range-bounds" });
  });

  it("carries a refinement's values as params", () => {
    const issue = firstIssue(ConditionSchema, { type: "exists", path: "output.x" });
    expect(zodIssueMessage(issue)).toEqual({
      key: "errors.schema.condition.output-root",
      params: { path: "output.x" },
    });
  });

  it("keeps the English text of a refinement as the issue message", () => {
    const issue = firstIssue(ConditionSchema, { type: "range", path: "previous.n" });
    expect(issue.message).toBe("a range condition requires at least one of min/max");
  });

  it("codes a check's own message, keeping its English text", () => {
    const name = firstIssue(NameSchema, "Bad");
    expect(zodIssueMessage(name)).toEqual({ key: "errors.schema.node.bad-name" });
    expect(name.message).toBe("name must match ^[a-z][a-z0-9-]*$");
    expect(zodIssueMessage(firstIssue(IdSchema, "x"))).toEqual({
      key: "errors.schema.node.bad-id",
    });
  });

  it("keeps zod's own message for a built-in issue", () => {
    const issue = firstIssue(z.string(), 3);
    expect(zodIssueMessage(issue)).toEqual({
      key: "shared.verbatim",
      params: { text: issue.message },
    });
  });
});

describe("issueMessages", () => {
  it("prefixes each issue with its dot-path", () => {
    const result = z.object({ when: ConditionSchema }).safeParse({
      when: { type: "range", path: "previous.n" },
    });
    expect(result.success).toBe(false);
    expect(issueMessages(result.error!)).toEqual([
      {
        key: "shared.issueAtPath",
        params: { path: "when", issue: { key: "errors.schema.condition.range-bounds" } },
      },
    ]);
  });
});
