import { describe, expect, it } from "vitest";
import { codedMessage, decodeError, errorCodeOf, errorText } from "../src/coded-error.js";
import { verbatim } from "../src/message.js";

describe("coded error", () => {
  it("round-trips a code and params through the wire shape back to its Message", () => {
    const params = { rootRunId: "r1" };
    const wire = {
      code: "run.resume.succeeded",
      params,
      message: errorText("run.resume.succeeded", params),
    };

    expect(wire.message).toBe('run "r1" already succeeded; there is nothing to resume');
    expect(decodeError(wire.code, wire.params, wire.message)).toEqual(
      codedMessage("run.resume.succeeded", params),
    );
  });

  it("round-trips a Message through its code, as a run event stores it", () => {
    const message = codedMessage("run.resume.succeeded", { rootRunId: "r1" });
    const coded = errorCodeOf(message);

    expect(coded).toEqual({ code: "run.resume.succeeded", params: { rootRunId: "r1" } });
    expect(decodeError(coded?.code, coded?.params, "stored")).toEqual(message);
  });

  it("has no code for a message outside the errors namespace", () => {
    expect(errorCodeOf(verbatim("x"))).toBeUndefined();
  });

  it("shows the fallback as is for a missing, unknown or branch code", () => {
    expect(decodeError(undefined, undefined, "old text")).toEqual(verbatim("old text"));
    expect(decodeError("no.such.code", {}, "new server")).toEqual(verbatim("new server"));
    expect(decodeError("run.resume", {}, "branch")).toEqual(verbatim("branch"));
  });
});
