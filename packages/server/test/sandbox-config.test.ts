import { describe, expect, it } from "vitest";
import { readSandboxOptions } from "../src/sandbox/sandbox-config.js";

describe("readSandboxOptions", () => {
  it("is off without an image", () => {
    expect(readSandboxOptions({})).toBeUndefined();
  });

  it("passes only the allowlisted host variables to the VM", () => {
    const options = readSandboxOptions({
      PATH_SANDBOX_IMAGE: "path-run:1",
      PATH_SANDBOX_NETWORK: "path",
      DEEPSEEK_BASE_URL: "https://gateway.example",
      ANTHROPIC_API_KEY: "the owner's key",
    });
    expect(options).toMatchObject({
      image: "path-run:1",
      network: "path",
      cpus: 4,
      memoryMiB: 4096,
      timeoutMs: 3_600_000,
      hostEnv: { DEEPSEEK_BASE_URL: "https://gateway.example" },
    });
    expect(options?.hostEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
});
