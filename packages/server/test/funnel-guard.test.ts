import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { funnelGuardEnabled, isPublicRequest } from "../src/funnel-guard.js";
import type { ServerMode } from "../src/mode.js";
import { hostedMode } from "./fixtures/clerk-token.js";
import { stubEgressAnchor } from "./fixtures/egress-status.js";

/** A minimal `IncomingMessage` stand-in — the guard only reads `.headers`. */
function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("isPublicRequest", () => {
  it("treats a *.ts.net Host with no Tailscale-User-Login as a Funnel request", () => {
    expect(isPublicRequest(req({ host: "mac-mini.tailnet.ts.net" }))).toBe(true);
  });

  it("ignores the port on the Host", () => {
    expect(isPublicRequest(req({ host: "mac-mini.tailnet.ts.net:443" }))).toBe(true);
  });

  it("matches the Host case-insensitively", () => {
    expect(isPublicRequest(req({ host: "MAC-MINI.TAILNET.TS.NET" }))).toBe(true);
  });

  it("passes a tailnet request that carries the Serve identity header", () => {
    expect(
      isPublicRequest(
        req({ host: "mac-mini.tailnet.ts.net", "tailscale-user-login": "owner@example.com" }),
      ),
    ).toBe(false);
  });

  it("passes a plain localhost request", () => {
    expect(isPublicRequest(req({ host: "localhost:5173" }))).toBe(false);
  });

  it("refuses a request with no Host at all", () => {
    expect(isPublicRequest(req({}))).toBe(true);
  });

  it("refuses the bare tailnet domain even with Tailscale-User-Login", () => {
    expect(isPublicRequest(req({ host: "ts.net", "tailscale-user-login": "a@b.c" }))).toBe(true);
  });

  it("refuses a custom-domain Host, as Cloudflare Tunnel sends it", () => {
    expect(isPublicRequest(req({ host: "path.rheinwegde.de" }))).toBe(true);
  });

  it("refuses a custom-domain Host that forges Tailscale-User-Login", () => {
    expect(
      isPublicRequest(req({ host: "path.rheinwegde.de", "tailscale-user-login": "a@b.c" })),
    ).toBe(true);
  });

  it("passes the loopback addresses", () => {
    expect(isPublicRequest(req({ host: "127.0.0.1:8787" }))).toBe(false);
    expect(isPublicRequest(req({ host: "[::1]:8787" }))).toBe(false);
  });

  it.each(["cf-connecting-ip", "cf-ray", "x-forwarded-for", "forwarded"])(
    "refuses a loopback Host that carries %s",
    (name) => {
      expect(isPublicRequest(req({ host: "localhost:8787", [name]: "203.0.113.7" }))).toBe(true);
    },
  );

  it("refuses a Serve-shaped request that carries Cloudflare headers", () => {
    expect(
      isPublicRequest(
        req({
          host: "mac-mini.tailnet.ts.net",
          "tailscale-user-login": "a@b.c",
          "cf-connecting-ip": "203.0.113.7",
        }),
      ),
    ).toBe(true);
  });

  it("passes a Serve request that carries X-Forwarded-For", () => {
    expect(
      isPublicRequest(
        req({
          host: "mac-mini.tailnet.ts.net",
          "tailscale-user-login": "a@b.c",
          "x-forwarded-for": "100.64.0.1",
        }),
      ),
    ).toBe(false);
  });

  it("ignores a trailing root dot on the Host", () => {
    expect(isPublicRequest(req({ host: "mac-mini.tailnet.ts.net." }))).toBe(true);
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
    const hosted = { mode: "hosted" } as ServerMode;
    expect(funnelGuardEnabled(hosted, {})).toBe(false);
  });
});

describe("the funnel guard on the HTTP door", () => {
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

  it("refuses a custom-domain Host, as Cloudflare Tunnel sends it", async () => {
    const res = await get("/v0/runs", "path.rheinwegde.de", { "cf-connecting-ip": "203.0.113.7" });
    expect(res.status).toBe(403);
    expect(errorMessage(res.body)).toContain("Cloudflare Tunnel");
  });

  it("refuses a localhost Host that a proxy forwarded", async () => {
    const res = await get("/v0/runs", "localhost", { "x-forwarded-for": "203.0.113.7" });
    expect(res.status).toBe(403);
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
    vi.stubEnv("PATH_SANDBOX_IMAGE", "path-run:test");
    stubEgressAnchor();
    handle = await startPathServer(projectDir, { mode: hostedMode(projectDir) });
    // Past the guard, the request meets hosted sign-in instead.
    expect((await get("/v0/runs", TS_NET_HOST)).status).toBe(401);
  });
});
