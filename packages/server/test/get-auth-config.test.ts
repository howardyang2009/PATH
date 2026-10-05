import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { PUBLISHABLE_KEY, stubHostedEnv } from "./fixtures/clerk-token.js";

describe("GET /v0/auth-config", () => {
  let projectDir: string;
  let handle: PathServerHandle | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-auth-config-test-"));
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    rmSync(projectDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("answers local mode with no publishable key", async () => {
    handle = await startPathServer(projectDir);
    const res = await fetch(`${handle.url}/v0/auth-config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "local", publishableKey: null });
  });

  it("answers hosted mode with the publishable key, without a token", async () => {
    stubHostedEnv();
    handle = await startPathServer(projectDir);
    const res = await fetch(`${handle.url}/v0/auth-config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "hosted", publishableKey: PUBLISHABLE_KEY });
  });
});
