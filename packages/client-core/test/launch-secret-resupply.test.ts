import { describe, expect, it } from "vitest";
import {
  blankSecretPaths,
  launchSecretResupply,
  resupplyGate,
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

describe("resupplyGate — the one submit verdict both continuation doors read", () => {
  it("blocks on a blank secret, wording the message for the verb", () => {
    const gate = resupplyGate(["token"], secretSkeletonJson(["token"]), "resuming");
    expect(gate.ok).toBe(false);
    expect(gate.blankPaths).toEqual(["token"]);
    expect(gate.blockMessage).toBe(
      'Launch secret "token" is empty — enter a value before resuming.',
    );
  });

  it("names every blank secret, plural, for completing", () => {
    const gate = resupplyGate(["a", "b"], "{}", "completing");
    expect(gate.blockMessage).toBe(
      'Launch secrets "a", "b" are empty — enter a value for each before completing.',
    );
  });

  it("passes once every recorded secret has a value", () => {
    const gate = resupplyGate(["token"], JSON.stringify({ token: "sk-live" }), "resuming");
    expect(gate.ok).toBe(true);
    expect(gate.blankPaths).toEqual([]);
    expect(gate.blockMessage).toBeNull();
    expect(gate.configResult.ok && gate.configResult.value).toEqual({ token: "sk-live" });
  });

  it("leaves an invalid config to the field's own lint — no secret-level block", () => {
    const gate = resupplyGate(["token"], "{ not json", "completing");
    expect(gate.ok).toBe(false);
    expect(gate.configResult.ok).toBe(false);
    expect(gate.blockMessage).toBeNull();
  });

  it("passes with no recorded secrets and a blank draft (the plain continuation body)", () => {
    const gate = resupplyGate([], "", "resuming");
    expect(gate.ok).toBe(true);
    expect(gate.configResult.ok && gate.configResult.value).toBeUndefined();
  });
});
