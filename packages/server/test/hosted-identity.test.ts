import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clerkUserIdResolver } from "../src/clerk-identity.js";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { readServerMode } from "../src/mode.js";

/**
 * Hosted-mode identity (ADR 0090): the Server verifies a Clerk session token on every `/v0/*`
 * request against a locally held key, with no network call. Tokens here are signed with a key
 * generated per run, in the shape a Clerk session token has.
 */

const ORIGIN = "https://path.example.ts.net";
const PUBLISHABLE_KEY = "pk_test_cGF0aC5leGFtcGxlJA";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A Clerk-shaped RS256 session token; `claims` override the valid defaults. */
function token(claims: Record<string, unknown> = {}, key: KeyObject = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "RS256", typ: "JWT", kid: "ins_test" });
  const payload = base64url({
    sub: "user_2abcDEF123",
    azp: ORIGIN,
    iss: "https://clerk.path.example",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 60,
    ...claims,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

describe("readServerMode", () => {
  it("is local with no Clerk settings", () => {
    expect(readServerMode({})).toEqual({ mode: "local" });
  });

  it("is hosted with both settings and the publishable key", () => {
    expect(
      readServerMode({
        CLERK_JWT_KEY: JWT_KEY,
        PATH_ALLOWED_ORIGIN: ORIGIN,
        CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
      }),
    ).toEqual({
      mode: "hosted",
      jwtKey: JWT_KEY,
      allowedOrigin: ORIGIN,
      publishableKey: PUBLISHABLE_KEY,
    });
  });

  it("refuses CLERK_JWT_KEY alone", () => {
    expect(() => readServerMode({ CLERK_JWT_KEY: JWT_KEY })).toThrow(/PATH_ALLOWED_ORIGIN/);
  });

  it("refuses PATH_ALLOWED_ORIGIN alone", () => {
    expect(() => readServerMode({ PATH_ALLOWED_ORIGIN: ORIGIN })).toThrow(/CLERK_JWT_KEY/);
  });

  it("refuses hosted mode without a publishable key", () => {
    expect(() => readServerMode({ CLERK_JWT_KEY: JWT_KEY, PATH_ALLOWED_ORIGIN: ORIGIN })).toThrow(
      /CLERK_PUBLISHABLE_KEY/,
    );
  });
});

describe("clerkUserIdResolver", () => {
  const resolve = clerkUserIdResolver({ jwtKey: JWT_KEY, allowedOrigin: ORIGIN });

  function request(authorization?: string): IncomingMessage {
    return { headers: { authorization } } as unknown as IncomingMessage;
  }

  it("yields the verified sub as the user id", async () => {
    expect(await resolve(request(`Bearer ${token()}`))).toBe("user_2abcDEF123");
  });

  it("yields no user id without a bearer token", async () => {
    expect(await resolve(request())).toBeUndefined();
    expect(await resolve(request("Bearer "))).toBeUndefined();
  });

  it("yields no user id for local, even when signed", async () => {
    expect(await resolve(request(`Bearer ${token({ sub: "local" })}`))).toBeUndefined();
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

  async function startHosted(): Promise<PathServerHandle> {
    vi.stubEnv("CLERK_JWT_KEY", JWT_KEY);
    vi.stubEnv("PATH_ALLOWED_ORIGIN", ORIGIN);
    vi.stubEnv("CLERK_PUBLISHABLE_KEY", PUBLISHABLE_KEY);
    handle = await startPathServer(projectDir);
    return handle;
  }

  function bearer(value: string): RequestInit {
    return { headers: { Authorization: `Bearer ${value}` } };
  }

  it("refuses to start with only one hosted setting", async () => {
    vi.stubEnv("CLERK_JWT_KEY", JWT_KEY);
    await expect(startPathServer(projectDir)).rejects.toThrow(/PATH_ALLOWED_ORIGIN/);
  });

  it("answers 401 to a request with no token", async () => {
    const { url } = await startHosted();
    expect((await fetch(`${url}/v0/runs`)).status).toBe(401);
  });

  it("answers 401 to a token that is not a bearer token", async () => {
    const { url } = await startHosted();
    const res = await fetch(`${url}/v0/runs`, { headers: { Authorization: token() } });
    expect(res.status).toBe(401);
  });

  it("answers 401 to a token signed with another key", async () => {
    const { url } = await startHosted();
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect((await fetch(`${url}/v0/runs`, bearer(token({}, other)))).status).toBe(401);
  });

  it("answers 401 to an expired token", async () => {
    const { url } = await startHosted();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const expired = token({ iat: past - 60, nbf: past - 60, exp: past });
    expect((await fetch(`${url}/v0/runs`, bearer(expired))).status).toBe(401);
  });

  it("answers 401 to a token issued for another origin", async () => {
    const { url } = await startHosted();
    const res = await fetch(`${url}/v0/runs`, bearer(token({ azp: "https://evil.example" })));
    expect(res.status).toBe(401);
  });

  it("answers 401 to a sub that is not a Clerk user id", async () => {
    const { url } = await startHosted();
    for (const sub of ["local", "user_../x", "org_abc"]) {
      expect((await fetch(`${url}/v0/runs`, bearer(token({ sub })))).status).toBe(401);
    }
  });

  it("answers a request with a valid token as that token's user", async () => {
    const { url } = await startHosted();
    const res = await fetch(`${url}/v0/runs`, bearer(token()));
    expect(res.status).toBe(200);
  });

  it("serves auth-config without a token", async () => {
    const { url } = await startHosted();
    const res = await fetch(`${url}/v0/auth-config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "hosted", publishableKey: PUBLISHABLE_KEY });
  });

  it("keeps the static mounts public", async () => {
    const { url } = await startHosted();
    const res = await fetch(`${url}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
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

  it("answers auth-config with local mode and no publishable key", async () => {
    const res = await fetch(`${handle.url}/v0/auth-config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "local", publishableKey: null });
  });

  it("needs no token", async () => {
    expect((await fetch(`${handle.url}/v0/runs`)).status).toBe(200);
  });
});
