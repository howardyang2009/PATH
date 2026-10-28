import { describe, expect, it } from "vitest";
import {
  blankSecretPaths,
  launchSecretResupply,
  readOverride,
  secretSkeletonJson,
} from "../src/launch-secret-resupply.js";

describe("launchSecretResupply — the config field's initial state", () => {
  it("requires the field and prefills a nested skeleton when the launch recorded secrets", () => {
    const r = launchSecretResupply(["a.b", "token"]);
    expect(r.required).toBe(true);
    expect(JSON.parse(r.skeleton)).toEqual({ a: { b: "" }, token: "" });
  });

  it("requires nothing and prefills empty when the launch recorded no secrets", () => {
    expect(launchSecretResupply([])).toEqual({ required: false, skeleton: "" });
  });
});

describe("secretSkeletonJson — nesting", () => {
  it("promotes a leaf to a container when a longer key needs it", () => {
    expect(JSON.parse(secretSkeletonJson(["a", "a.b"]))).toEqual({ a: { b: "" } });
  });
});

describe("blankSecretPaths — the still-unusable recorded paths", () => {
  it("reports a masked, absent, or whitespace value and clears on a real one", () => {
    expect(blankSecretPaths(["token"], undefined)).toEqual(["token"]);
    expect(blankSecretPaths(["token"], { token: "" })).toEqual(["token"]);
    expect(blankSecretPaths(["token"], { token: "  " })).toEqual(["token"]);
    expect(blankSecretPaths(["a.b"], { a: { b: "sk-live" } })).toEqual([]);
  });
});

describe("readOverride — the one reading every override field takes", () => {
  it("asks for nothing on a blank draft", () => {
    const reading = readOverride({ text: "" });
    expect(reading.isEmpty).toBe(true);
    expect(reading.result.ok).toBe(true);
    expect(reading.canSubmit).toBe(true);
  });

  it("treats a literal {} as no override", () => {
    const reading = readOverride({ text: "{}" });
    expect(reading.isEmpty).toBe(true);
    expect(reading.result.ok && reading.result.value).toEqual({});
  });

  it("reads a draft with keys as an override", () => {
    const reading = readOverride({ text: '{"model": "x"}' });
    expect(reading.isEmpty).toBe(false);
    expect(reading.canSubmit).toBe(true);
  });

  it("blocks on a blank secret, wording the message for the verb", () => {
    const reading = readOverride({
      text: secretSkeletonJson(["token"]),
      secretPaths: ["token"],
      verb: "resuming",
    });
    expect(reading.canSubmit).toBe(false);
    expect(reading.blankPaths).toEqual(["token"]);
    expect(reading.blockMessage).toEqual({
      key: "events.resupply.blankSecrets",
      params: { count: 1, names: ['"token"'], verb: "resuming" },
    });
  });

  it("names every blank secret, plural, for completing", () => {
    const reading = readOverride({ text: "{}", secretPaths: ["a", "b"], verb: "completing" });
    expect(reading.blockMessage).toEqual({
      key: "events.resupply.blankSecrets",
      params: { count: 2, names: ['"a"', '"b"'], verb: "completing" },
    });
  });

  it("passes once every recorded secret has a value", () => {
    const reading = readOverride({
      text: JSON.stringify({ token: "sk-live" }),
      secretPaths: ["token"],
      verb: "resuming",
    });
    expect(reading.canSubmit).toBe(true);
    expect(reading.blankPaths).toEqual([]);
    expect(reading.blockMessage).toBeNull();
    expect(reading.result.ok && reading.result.value).toEqual({ token: "sk-live" });
  });

  it("leaves an invalid draft to the field's own lint — no secret-level block", () => {
    const reading = readOverride({
      text: "{ not json",
      secretPaths: ["token"],
      verb: "completing",
    });
    expect(reading.canSubmit).toBe(false);
    expect(reading.result.ok).toBe(false);
    expect(reading.blockMessage).toBeNull();
  });

  it("passes with no recorded secrets and a blank draft (the plain continuation body)", () => {
    const reading = readOverride({ text: "", verb: "resuming" });
    expect(reading.canSubmit).toBe(true);
    expect(reading.result.ok && reading.result.value).toBeUndefined();
  });
});
