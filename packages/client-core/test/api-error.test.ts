import { verbatim } from "@path/i18n";
import { describe, expect, it } from "vitest";
import { apiErrorMessage, PathApiError, toApiError } from "../src/transport.js";

const envelope = (error: object): string => JSON.stringify({ error });

describe("toApiError", () => {
  it("keeps the code and params of an ADR 0107 envelope", () => {
    const error = toApiError(
      404,
      envelope({ code: "run.not-found", params: { rootRunId: "r1" }, message: "no run" }),
    );
    expect(error).toMatchObject({
      status: 404,
      code: "run.not-found",
      params: { rootRunId: "r1" },
      message: "no run",
    });
  });

  it("names a body that is not JSON by a client code", () => {
    expect(toApiError(502, "<html>")).toMatchObject({
      code: "client.request-failed",
      params: { status: 502 },
      message: "request failed with status 502",
    });
  });
});

describe("apiErrorMessage", () => {
  it("renders a known code from the catalogue", () => {
    const error = new PathApiError(404, "no run", undefined, "run.not-found", { rootRunId: "r1" });
    expect(apiErrorMessage(error)).toEqual({
      key: "errors.run.not-found",
      params: { rootRunId: "r1" },
    });
  });

  it("falls back to the English message for an unknown or absent code", () => {
    expect(
      apiErrorMessage(new PathApiError(409, "newer refusal", undefined, "run.brand-new")),
    ).toEqual(verbatim("newer refusal"));
    expect(apiErrorMessage(new PathApiError(409, "old server"))).toEqual(verbatim("old server"));
  });

  it("carries a thrown non-API error verbatim", () => {
    expect(apiErrorMessage(new TypeError("Failed to fetch"))).toEqual(verbatim("Failed to fetch"));
    expect(apiErrorMessage("boom")).toEqual(verbatim("boom"));
  });
});
