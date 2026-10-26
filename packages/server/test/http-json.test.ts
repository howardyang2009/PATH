import { describe, expect, it } from "vitest";
import { replyError } from "../src/http-json.js";

describe("replyError (ADR 0107)", () => {
  it("answers the code and params with the English message from the catalogue", () => {
    expect(replyError(404, "run.not-found", { rootRunId: "r1" })).toEqual({
      status: 404,
      body: {
        error: {
          code: "run.not-found",
          params: { rootRunId: "r1" },
          message: 'no run found with id "r1"',
        },
      },
    });
  });

  it("carries details next to the message", () => {
    expect(replyError(400, "workflow.invalid", {}, ["bad"]).body).toEqual({
      error: {
        code: "workflow.invalid",
        params: {},
        message: "workflow validation failed",
        details: ["bad"],
      },
    });
  });
});
