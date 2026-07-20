import type { ConfigObject } from "@path/schema";
import { describe, expect, it, vi } from "vitest";
import type { RunObserver } from "../src/run-observer.js";
import { collectSecrets, createMaskingObserver } from "../src/secret-mask.js";

describe("collectSecrets", () => {
  it("scrubs a secret value by its config key wherever it appears in a string", () => {
    const masker = collectSecrets([{ apiKey: { $secret: "s3cr3t-token-value" } }]);
    expect(masker.isEmpty).toBe(false);
    expect(masker.maskString("Authorization: Bearer s3cr3t-token-value done")).toBe(
      "Authorization: Bearer [secret:apiKey] done",
    );
  });

  it("deep-scrubs every string leaf of a JSON value, leaving non-strings alone", () => {
    const masker = collectSecrets([{ token: { $secret: "abcdef123456" } }]);
    expect(
      masker.maskValue({ auth: "abcdef123456", nested: ["abcdef123456", 7, true], count: 42 }),
    ).toEqual({ auth: "[secret:token]", nested: ["[secret:token]", 7, true], count: 42 });
  });

  it("collects secrets nested at any depth under a dotted key path", () => {
    const masker = collectSecrets([{ creds: { headers: { auth: { $secret: "deep-secret-value" } } } }]);
    expect(masker.maskString("x=deep-secret-value")).toBe("x=[secret:creds.headers.auth]");
  });

  it("resolves a duplicate value to the first key it was collected under", () => {
    const masker = collectSecrets([{ primary: { $secret: "same-secret-value" }, alias: { $secret: "same-secret-value" } }]);
    expect(masker.maskString("same-secret-value")).toBe("[secret:primary]");
  });

  it("earlier config sources win the token key for a duplicated value", () => {
    const operator: ConfigObject = { opKey: { $secret: "shared-secret-value" } };
    const file: ConfigObject = { fileKey: { $secret: "shared-secret-value" } };
    expect(collectSecrets([operator, file]).maskString("shared-secret-value")).toBe("[secret:opKey]");
  });

  it("warns about a suspiciously short secret but still masks it", () => {
    const masker = collectSecrets([{ pin: { $secret: "ab" } }]);
    expect(masker.warnings).toHaveLength(1);
    expect(masker.warnings[0]).toMatch(/pin/);
    expect(masker.maskString("ab")).toBe("[secret:pin]");
  });

  it("is empty and warning-free when no secrets are present", () => {
    const masker = collectSecrets([{ model: "claude", endpoint: "https://example.test" }]);
    expect(masker.isEmpty).toBe(true);
    expect(masker.warnings).toEqual([]);
    expect(masker.maskString("nothing to hide")).toBe("nothing to hide");
  });

  it("masks the longer of two overlapping secrets before its substring", () => {
    const masker = collectSecrets([{ full: { $secret: "abc123def" } }, { part: { $secret: "abc" } }]);
    expect(masker.maskString("abc123def and abc")).toBe("[secret:full] and [secret:part]");
  });
});

describe("createMaskingObserver", () => {
  it("scrubs every persisted payload field before it reaches the inner observer", async () => {
    const masker = collectSecrets([{ apiKey: { $secret: "top-secret-value" } }]);
    const inner: RunObserver = {
      runStarted: vi.fn(),
      stepStarted: vi.fn(),
      stepStderr: vi.fn(),
      stepFinished: vi.fn(),
      contextChanged: vi.fn(),
      runFinished: vi.fn(),
    };
    const observer = createMaskingObserver(masker, inner);

    await observer.runStarted?.({ runId: "r", rootRunId: "r", parentRunId: null, nodeId: null, input: { k: "top-secret-value" }, worker: { type: "engine" } });
    await observer.stepStarted?.({ runId: "s", rootRunId: "r", parentRunId: "r", nodeId: "n", stepType: "binary", worker: { type: "engine" }, input: "top-secret-value" });
    await observer.stepStderr?.({ runId: "s", rootRunId: "r", stderr: "boom top-secret-value" });
    await observer.stepFinished?.({ runId: "s", rootRunId: "r", status: "failed", error: "died with top-secret-value" });
    await observer.contextChanged?.({ runId: "r", rootRunId: "r", context: { saved: "top-secret-value" } });
    await observer.runFinished?.({ runId: "r", rootRunId: "r", status: "succeeded", output: { out: "top-secret-value" } });

    expect(vi.mocked(inner.runStarted!).mock.calls[0]![0].input).toEqual({ k: "[secret:apiKey]" });
    expect(vi.mocked(inner.stepStarted!).mock.calls[0]![0].input).toBe("[secret:apiKey]");
    expect(vi.mocked(inner.stepStderr!).mock.calls[0]![0].stderr).toBe("boom [secret:apiKey]");
    const finished = vi.mocked(inner.stepFinished!).mock.calls[0]![0];
    expect(finished.status === "failed" && finished.error).toBe("died with [secret:apiKey]");
    expect(vi.mocked(inner.contextChanged!).mock.calls[0]![0].context).toEqual({ saved: "[secret:apiKey]" });
    const runFinished = vi.mocked(inner.runFinished!).mock.calls[0]![0];
    expect(runFinished.status === "succeeded" && runFinished.output).toEqual({ out: "[secret:apiKey]" });
  });

  it("propagates an inner observer's thrown error (audit-first failure policy)", async () => {
    const masker = collectSecrets([{ apiKey: { $secret: "top-secret-value" } }]);
    const inner: RunObserver = {
      runFinished: () => {
        throw new Error("backend down");
      },
    };
    const observer = createMaskingObserver(masker, inner);
    await expect(observer.runFinished?.({ runId: "r", rootRunId: "r", status: "succeeded", output: {} })).rejects.toThrow("backend down");
  });
});
