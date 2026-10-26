import { describe, expect, it } from "vitest";
import { credentialHint, credentialPlaceholder } from "../src/credential-hints.js";

describe("credentialHint", () => {
  it("names each prompt worker's credential key", () => {
    expect(credentialHint("deepseek")).toEqual({
      key: "events.credentialHint.config",
      params: { key: "DEEPSEEK_API_KEY" },
    });
    expect(credentialHint("anthropic")).toEqual({
      key: "events.credentialHint.setupToken",
      params: { key: "CLAUDE_CODE_OAUTH_TOKEN" },
    });
  });

  it("has no hint for a worker without a credential", () => {
    expect(credentialHint("spawn")).toBeUndefined();
    expect(credentialHint(undefined)).toBeUndefined();
  });
});

describe("credentialPlaceholder", () => {
  it("names every distinct credential key as a $secret", () => {
    expect(credentialPlaceholder(["deepseek", "spawn", "deepseek"])).toBe(
      '{"DEEPSEEK_API_KEY": {"$secret": "…"}}',
    );
    expect(JSON.parse(credentialPlaceholder(["anthropic", "deepseek"])!)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: { $secret: "…" },
      DEEPSEEK_API_KEY: { $secret: "…" },
    });
  });

  it("is undefined when no worker needs a credential", () => {
    expect(credentialPlaceholder(["spawn"])).toBeUndefined();
  });
});
