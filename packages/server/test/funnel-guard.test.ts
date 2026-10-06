import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { funnelGuardEnabled, isFunnelRequest } from "../src/funnel-guard.js";
import type { ServerMode } from "../src/mode.js";

/** A minimal `IncomingMessage` stand-in — the guard only reads `.headers`. */
function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("isFunnelRequest", () => {
  it("treats a *.ts.net Host with no Tailscale-User-Login as a Funnel request", () => {
    expect(isFunnelRequest(req({ host: "mac-mini.tailnet.ts.net" }))).toBe(true);
  });

  it("ignores the port on the Host", () => {
    expect(isFunnelRequest(req({ host: "mac-mini.tailnet.ts.net:443" }))).toBe(true);
  });

  it("matches the Host case-insensitively", () => {
    expect(isFunnelRequest(req({ host: "MAC-MINI.TAILNET.TS.NET" }))).toBe(true);
  });

  it("passes a tailnet request that carries the Serve identity header", () => {
    expect(
      isFunnelRequest(
        req({ host: "mac-mini.tailnet.ts.net", "tailscale-user-login": "owner@example.com" }),
      ),
    ).toBe(false);
  });

  it("passes a plain localhost request", () => {
    expect(isFunnelRequest(req({ host: "localhost:5173" }))).toBe(false);
  });

  it("passes a request with no Host at all", () => {
    expect(isFunnelRequest(req({}))).toBe(false);
  });

  it("does not treat the bare tailnet domain as a Funnel name", () => {
    expect(isFunnelRequest(req({ host: "ts.net" }))).toBe(false);
  });

  it("ignores a trailing root dot on the Host", () => {
    expect(isFunnelRequest(req({ host: "mac-mini.tailnet.ts.net." }))).toBe(true);
  });
});

describe("funnelGuardEnabled", () => {
  const LOCAL: ServerMode = { mode: "local", publishableKey: null };

  it("is on by default in local mode", () => {
    expect(funnelGuardEnabled(LOCAL, {})).toBe(true);
  });

  it("turns off when PATH_FUNNEL_GUARD is off", () => {
    expect(funnelGuardEnabled(LOCAL, { PATH_FUNNEL_GUARD: "off" })).toBe(false);
  });

  it("reads the switch case-insensitively and ignores surrounding whitespace", () => {
    expect(funnelGuardEnabled(LOCAL, { PATH_FUNNEL_GUARD: " OFF " })).toBe(false);
  });

  it("stays on for any other PATH_FUNNEL_GUARD value", () => {
    expect(funnelGuardEnabled(LOCAL, { PATH_FUNNEL_GUARD: "on" })).toBe(true);
  });

  it("does not apply in hosted mode", () => {
    const hosted: ServerMode = {
      mode: "hosted",
      publishableKey: "pk_test_cGF0aC5leGFtcGxlJA",
      clerk: { jwtKey: "-----BEGIN PUBLIC KEY-----", allowedOrigin: "https://path.example" },
      secretsKey: { id: "test", key: Buffer.alloc(32) },
    };
    expect(funnelGuardEnabled(hosted, {})).toBe(false);
  });
});

describe("the Funnel guard on the HTTP door", () => {
  const TS_NET_HOST = "mac-mini.tailnet.ts.net";
  const LOGIN_HEADER = "tailscale-user-login";

  let projectDir: string;
  let handle: PathServerHandle;

  /** `Host` is a forbidden header for `fetch`; the raw client is the only way to send it. */
  function get(
    path: string,
    host: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(handle.url);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path,
          method: "GET",
          headers: { host, ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              body: raw === "" ? undefined : JSON.parse(raw),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function errorMessage(body: unknown): string {
    return (body as { error: { message: string } }).error.message;
  }

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "path-server-funnel-test-"));
    handle = await startPathServer(projectDir);
  });

  afterEach(async () => {
    await handle.close();
    rmSync(projectDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("refuses a *.ts.net Host with no Tailscale-User-Login", async () => {
    const res = await get("/v0/runs", TS_NET_HOST);
    expect(res.status).toBe(403);
    expect(errorMessage(res.body)).toContain("funnel guard");
  });

  it("refuses non-API paths too", async () => {
    expect((await get("/", TS_NET_HOST)).status).toBe(403);
  });

  it("passes the same request when it carries Tailscale-User-Login", async () => {
    const res = await get("/v0/runs", TS_NET_HOST, { [LOGIN_HEADER]: "owner@example.com" });
    expect(res.status).toBe(200);
  });

  it("passes a localhost request", async () => {
    expect((await get("/v0/runs", "localhost")).status).toBe(200);
  });

  it("does not apply the guard from a server started with PATH_FUNNEL_GUARD=off", async () => {
    await handle.close();
    vi.stubEnv("PATH_FUNNEL_GUARD", "off");
    handle = await startPathServer(projectDir);
    expect((await get("/v0/runs", TS_NET_HOST)).status).toBe(200);
  });

  it("does not apply the guard from a server started in hosted mode", async () => {
    await handle.close();
    vi.stubEnv("CLERK_JWT_KEY", "-----BEGIN PUBLIC KEY-----");
    vi.stubEnv("PATH_ALLOWED_ORIGIN", `https://${TS_NET_HOST}`);
    vi.stubEnv("CLERK_PUBLISHABLE_KEY", "pk_test_cGF0aC5leGFtcGxlJA");
    vi.stubEnv("PATH_SECRETS_KEY", Buffer.alloc(32).toString("base64"));
    handle = await startPathServer(projectDir);
    // Past the guard, the request meets hosted sign-in instead.
    expect((await get("/v0/runs", TS_NET_HOST)).status).toBe(401);
  });
});
