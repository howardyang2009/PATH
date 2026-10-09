import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { createRateLimiter, readRequestLimits } from "../src/request-limits.js";
import { clerkToken, hostedMode, stubHostedEnv } from "./fixtures/clerk-token.js";

/**
 * Request limits (docs/spec/path-website.md §8): in hosted mode each user gets 120 requests per
 * minute, a 1 MB request body, 50 shared items and 1 MB per authored file, and the override map in
 * `.path/limits.json` changes any of them for one user. Local mode has no limits.
 */

const MIB = 1024 * 1024;
const ALICE = "user_alice";
const BOB = "user_bob";

let projectDir: string;
let shippedDir: string;
let handle: PathServerHandle | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-request-limits-project-"));
  shippedDir = mkdtempSync(join(tmpdir(), "path-request-limits-shipped-"));
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(shippedDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function writeLimits(content: unknown): void {
  mkdirSync(join(projectDir, ".path"), { recursive: true });
  writeFileSync(join(projectDir, ".path", "limits.json"), JSON.stringify(content));
}

async function start({ hosted = true }: { hosted?: boolean } = {}): Promise<string> {
  if (hosted) stubHostedEnv();
  handle = await startPathServer(projectDir, {
    shippedDir: { template: join(shippedDir, "template"), workflow: join(shippedDir, "workflow") },
    mode: hosted ? hostedMode(projectDir) : undefined,
  });
  return handle.url;
}

/** A request as `userId`, with an optional JSON body. */
function as(userId: string, method = "GET", body?: unknown): RequestInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${clerkToken({ sub: userId })}`,
  };
  if (body === undefined) return { method, headers };
  return {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** A workflow file whose one step runs `command`; a long command makes a large file. */
function workflow(name: string, command = "echo"): Record<string, unknown> {
  return {
    format: "path/workflow@6",
    id: randomUUID(),
    name,
    body: [{ type: "binary", id: randomUUID(), name: "step-one", command }],
  };
}

function saveSharedTemplate(url: string, userId: string, name: string): Promise<Response> {
  return fetch(
    `${url}/v0/templates`,
    as(userId, "POST", {
      kind: "step",
      name,
      origin: "shared",
      description: "fragment",
      body: {
        format: "path/workflow@6",
        id: randomUUID(),
        description: "fragment",
        body: [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }],
      },
    }),
  );
}

function putWorkflow(url: string, userId: string, path: string, file: unknown): Promise<Response> {
  return fetch(`${url}/v0/workflows`, as(userId, "PUT", { workflow_path: path, workflow: file }));
}

async function errorMessage(res: Response): Promise<string> {
  return ((await res.json()) as { error: { message: string } }).error.message;
}

describe("createRateLimiter", () => {
  it("refuses the request past the limit until the minute ends", () => {
    let now = 1_000_000;
    const limiter = createRateLimiter(() => now);
    expect(limiter.take(ALICE, 2)).toEqual({ ok: true });
    now += 10_000;
    expect(limiter.take(ALICE, 2)).toEqual({ ok: true });
    expect(limiter.take(ALICE, 2)).toEqual({ ok: false, retryAfterSeconds: 50 });
    expect(limiter.take(BOB, 2)).toEqual({ ok: true });
    now += 50_000;
    expect(limiter.take(ALICE, 2)).toEqual({ ok: true });
  });

  it("counts over a sliding minute, not a window that resets", () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    expect(limiter.take(ALICE, 2)).toEqual({ ok: true });
    now = 50_000;
    expect(limiter.take(ALICE, 2)).toEqual({ ok: true });
    // The first request leaves the minute at 60 s; the second stays until 110 s.
    now = 60_000;
    expect(limiter.take(ALICE, 2)).toEqual({ ok: true });
    expect(limiter.take(ALICE, 2)).toEqual({ ok: false, retryAfterSeconds: 50 });
  });

  it("refuses every request at a limit of 0", () => {
    const limiter = createRateLimiter(() => 0);
    expect(limiter.take(ALICE, 0)).toEqual({ ok: false, retryAfterSeconds: 60 });
  });
});

describe("readRequestLimits", () => {
  it("gives the defaults when no limits file exists", () => {
    expect(readRequestLimits(projectDir).forUser(ALICE)).toEqual({
      requestsPerMinute: 120,
      maxBodyBytes: MIB,
      maxSharedItems: 50,
      maxFileBytes: MIB,
      maxRunningVms: 1,
      vmSecondsPerDay: 7200,
      maxStorageBytes: 1024 * MIB,
    });
  });

  it("applies a user's overrides to that user only", () => {
    writeLimits({ users: { [ALICE]: { maxSharedItems: 0, requestsPerMinute: 500 } } });
    const limits = readRequestLimits(projectDir);
    expect(limits.forUser(ALICE)).toMatchObject({ maxSharedItems: 0, requestsPerMinute: 500 });
    expect(limits.forUser(BOB)).toMatchObject({ maxSharedItems: 50, requestsPerMinute: 120 });
  });

  it("throws on an unknown key or a negative value", () => {
    writeLimits({ users: { [ALICE]: { maxCpus: 1 } } });
    expect(() => readRequestLimits(projectDir)).toThrow(/limits\.json/);
    writeLimits({ users: { [ALICE]: { maxSharedItems: -1 } } });
    expect(() => readRequestLimits(projectDir)).toThrow(/limits\.json/);
  });
});

describe("request rate", () => {
  it("answers the 121st request in a minute with 429 and Retry-After", async () => {
    const url = await start();
    for (let i = 0; i < 120; i++) {
      expect((await fetch(`${url}/v0/secrets`, as(ALICE))).status).toBe(200);
    }
    const refused = await fetch(`${url}/v0/secrets`, as(ALICE));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await errorMessage(refused)).toMatch(/too many requests/);
    expect((await fetch(`${url}/v0/secrets`, as(BOB))).status).toBe(200);
  });

  it("refuses every request of a user whose override is 0", async () => {
    writeLimits({ users: { [ALICE]: { requestsPerMinute: 0 } } });
    const url = await start();
    expect((await fetch(`${url}/v0/secrets`, as(ALICE))).status).toBe(429);
    expect((await fetch(`${url}/v0/secrets`, as(BOB))).status).toBe(200);
  });

  it("does not limit local mode", async () => {
    const url = await start({ hosted: false });
    for (let i = 0; i < 125; i++) {
      expect((await fetch(`${url}/v0/workflows`)).status).toBe(200);
    }
  });
});

describe("request body", () => {
  it("answers a body over 1 MB with 413", async () => {
    const url = await start();
    const res = await fetch(`${url}/v0/secrets/BIG`, as(ALICE, "PUT", { value: "x".repeat(MIB) }));
    expect(res.status).toBe(413);
    expect(await errorMessage(res)).toMatch(/request body too large/);
  });

  it("answers a chunked body over 1 MB with 413", async () => {
    const url = new URL(await start());
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          method: "PUT",
          path: "/v0/secrets/BIG",
          headers: {
            Authorization: `Bearer ${clerkToken({ sub: ALICE })}`,
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      // The server may close the socket before the whole body is sent.
      req.on("error", reject);
      req.write('{"value":"');
      for (let i = 0; i < 8; i++) req.write("x".repeat(256 * 1024));
      req.end('"}');
    });
    expect(status).toBe(413);
  });

  it("closes the connection when an oversize body keeps coming", async () => {
    const url = new URL(await start());
    const req = request({
      host: url.hostname,
      port: url.port,
      method: "PUT",
      path: "/v0/secrets/BIG",
      headers: {
        Authorization: `Bearer ${clerkToken({ sub: ALICE })}`,
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
    });
    let closed = false;
    req.on("error", () => {});
    req.on("close", () => {
      closed = true;
    });
    req.on("response", (res) => res.resume());
    const chunk = "x".repeat(256 * 1024);
    let sent = 0;
    while (!closed && sent < 64 * MIB) {
      if (!req.write(chunk)) {
        await new Promise((resolve) => {
          req.once("drain", resolve);
          req.once("close", resolve);
        });
      }
      sent += chunk.length;
    }
    req.destroy();
    expect(closed).toBe(true);
    expect(sent).toBeLessThan(64 * MIB);
  });

  it("lets an override raise the body cap for that user", async () => {
    writeLimits({ users: { [ALICE]: { maxBodyBytes: 2 * MIB } } });
    const url = await start();
    const big = { value: "x".repeat(MIB + 10) };
    // Past the body cap, the Secret store's own value limit answers.
    expect((await fetch(`${url}/v0/secrets/BIG`, as(ALICE, "PUT", big))).status).toBe(400);
    expect((await fetch(`${url}/v0/secrets/BIG`, as(BOB, "PUT", big))).status).toBe(413);
  });
});

describe("shared items", () => {
  it("refuses the 51st shared item with 403, counting workflows and templates", async () => {
    const url = await start();
    for (let i = 0; i < 25; i++) {
      const path = `shared/workflow/w${i}.workflow.json`;
      expect((await putWorkflow(url, ALICE, path, workflow(`w${i}`))).status).toBe(201);
    }
    for (let i = 0; i < 25; i++) {
      expect((await saveSharedTemplate(url, ALICE, `t${i}`)).status).toBe(201);
    }
    const template = await saveSharedTemplate(url, ALICE, "t50");
    expect(template.status).toBe(403);
    expect(await errorMessage(template)).toMatch(/shared item limit reached \(50\)/);
    const path = "shared/workflow/w50.workflow.json";
    expect((await putWorkflow(url, ALICE, path, workflow("w50"))).status).toBe(403);

    // Overwriting an own shared item and saving to the user's own root still work.
    expect((await saveSharedTemplate(url, BOB, "bob")).status).toBe(201);
    const mine = `users/${ALICE}/workflow/mine.workflow.json`;
    expect((await putWorkflow(url, ALICE, mine, workflow("mine"))).status).toBe(201);
  });

  it("refuses every shared item of a user whose override is 0", async () => {
    writeLimits({ users: { [ALICE]: { maxSharedItems: 0 } } });
    const url = await start();
    expect((await saveSharedTemplate(url, ALICE, "a")).status).toBe(403);
    expect((await saveSharedTemplate(url, BOB, "b")).status).toBe(201);
  });
});

describe("authored file size", () => {
  // The body cap is raised, so the file-size check is what refuses.
  beforeEach(() => writeLimits({ users: { [ALICE]: { maxBodyBytes: 4 * MIB } } }));

  it("refuses a workflow file over 1 MB with 403 in every origin", async () => {
    const url = await start();
    const big = workflow("big", "x".repeat(MIB));
    for (const path of [
      `users/${ALICE}/workflow/big.workflow.json`,
      "shared/workflow/big.workflow.json",
    ]) {
      const res = await putWorkflow(url, ALICE, path, big);
      expect(res.status).toBe(403);
      expect(await errorMessage(res)).toMatch(/file too large/);
    }
  });

  it("refuses a template over 1 MB with 403", async () => {
    const url = await start();
    const res = await fetch(
      `${url}/v0/templates`,
      as(ALICE, "POST", {
        kind: "step",
        name: "big",
        description: "fragment",
        body: {
          format: "path/workflow@6",
          id: randomUUID(),
          description: "x".repeat(MIB),
          body: [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }],
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toMatch(/file too large/);
  });

  it("refuses a template update over 1 MB with 403", async () => {
    const url = await start();
    const template = {
      format: "path/workflow@6",
      id: randomUUID(),
      description: "fragment",
      body: [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }],
    };
    const created = await fetch(
      `${url}/v0/templates`,
      as(ALICE, "POST", { kind: "step", name: "t", description: "fragment", body: template }),
    );
    const etag = created.headers.get("ETag") ?? "";
    const init = as(ALICE, "PUT", { ...template, description: "x".repeat(MIB) });
    const res = await fetch(`${url}/v0/templates/${template.id}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), "If-Match": etag },
    });
    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toMatch(/file too large/);
  });

  it("lets an override raise the file size for that user", async () => {
    writeLimits({ users: { [ALICE]: { maxBodyBytes: 4 * MIB, maxFileBytes: 2 * MIB } } });
    const url = await start();
    const path = `users/${ALICE}/workflow/big.workflow.json`;
    expect((await putWorkflow(url, ALICE, path, workflow("big", "x".repeat(MIB)))).status).toBe(
      201,
    );
  });
});
