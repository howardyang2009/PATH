import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListWorkflowsResponse } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clerkUserIdResolver } from "../src/clerk-identity.js";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import {
  bearer,
  clerkToken,
  hostedMode,
  JWT_KEY,
  ORIGIN,
  stubHostedEnv,
  USER_ID,
} from "./fixtures/clerk-token.js";

/**
 * Hosted-mode identity: the Server verifies a Clerk session token on every `/v0/*` request against
 * a locally held key, and the token's `sub` is the requester's user id.
 */

describe("clerkUserIdResolver", () => {
  const resolve = clerkUserIdResolver({ jwtKey: JWT_KEY, allowedOrigin: ORIGIN });

  function request(authorization?: string): IncomingMessage {
    return { headers: { authorization } } as unknown as IncomingMessage;
  }

  it("yields the verified sub as the user id", async () => {
    expect(await resolve(request(`Bearer ${clerkToken()}`))).toBe(USER_ID);
  });

  it("yields no user id without a bearer token", async () => {
    expect(await resolve(request())).toBeUndefined();
    expect(await resolve(request("Bearer "))).toBeUndefined();
    expect(await resolve(request(clerkToken()))).toBeUndefined();
  });

  it("yields no user id for a token signed with another key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(await resolve(request(`Bearer ${clerkToken({}, other)}`))).toBeUndefined();
  });

  it("yields no user id for an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const expired = clerkToken({ iat: past - 60, nbf: past - 60, exp: past });
    expect(await resolve(request(`Bearer ${expired}`))).toBeUndefined();
  });

  it("yields no user id for a token issued for another origin, or for none", async () => {
    const other = clerkToken({ azp: "https://evil.example" });
    expect(await resolve(request(`Bearer ${other}`))).toBeUndefined();
    expect(await resolve(request(`Bearer ${clerkToken({ azp: undefined })}`))).toBeUndefined();
  });

  it("yields no user id for a sub that is not a Clerk user id", async () => {
    for (const sub of ["local", "user_../x", "org_abc"]) {
      expect(await resolve(request(`Bearer ${clerkToken({ sub })}`))).toBeUndefined();
    }
  });
});

describe("the hosted Server", () => {
  let projectDir: string;
  let handle: PathServerHandle | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-server-hosted-test-"));
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    rmSync(projectDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function startHosted(): Promise<string> {
    stubHostedEnv();
    handle = await startPathServer(
      projectDir,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      hostedMode(projectDir),
    );
    return handle.url;
  }

  /** A workflow file in `userId`'s own workflow root. */
  function writeUserWorkflow(userId: string, name: string): void {
    const dir = join(projectDir, "users", userId, "workflow");
    mkdirSync(dir, { recursive: true });
    const body = [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }];
    writeFileSync(
      join(dir, `${name}.workflow.json`),
      JSON.stringify({ format: "path/workflow@6", id: randomUUID(), name, body }),
    );
  }

  it("refuses to start with only one hosted setting", async () => {
    vi.stubEnv("CLERK_JWT_KEY", JWT_KEY);
    await expect(startPathServer(projectDir)).rejects.toThrow(/PATH_ALLOWED_ORIGIN/);
  });

  it("answers 401 to a request with no token", async () => {
    const url = await startHosted();
    expect((await fetch(`${url}/v0/runs`)).status).toBe(401);
  });

  it("answers 401 to an invalid token", async () => {
    const url = await startHosted();
    expect((await fetch(`${url}/v0/runs`, bearer("not.a.token"))).status).toBe(401);
  });

  it("answers 401 to an expired token", async () => {
    const url = await startHosted();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const expired = clerkToken({ iat: past - 60, nbf: past - 60, exp: past });
    expect((await fetch(`${url}/v0/runs`, bearer(expired))).status).toBe(401);
  });

  it("serves a valid token's request as the token's user", async () => {
    writeUserWorkflow(USER_ID, "mine");
    writeUserWorkflow("user_someoneElse", "theirs");
    const url = await startHosted();

    const res = await fetch(`${url}/v0/workflows`, bearer(clerkToken()));

    expect(res.status).toBe(200);
    const names = ((await res.json()) as ListWorkflowsResponse).workflows.map((w) => w.name);
    expect(names).toContain("mine");
    expect(names).not.toContain("theirs");
  });

  it("keeps the static mounts public", async () => {
    const url = await startHosted();
    expect((await fetch(`${url}/`, { redirect: "manual" })).status).toBe(302);
  });
});

describe("the local Server", () => {
  let projectDir: string;
  let handle: PathServerHandle;

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "path-server-local-auth-test-"));
    handle = await startPathServer(projectDir);
  });

  afterEach(async () => {
    await handle.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("needs no token", async () => {
    expect((await fetch(`${handle.url}/v0/runs`)).status).toBe(200);
  });
});
