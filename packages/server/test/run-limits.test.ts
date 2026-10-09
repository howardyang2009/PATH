import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { openCreatorTable } from "../src/creator-table.js";
import { DEFAULT_LIMITS } from "../src/request-limits.js";
import { createRunLimits } from "../src/run-limits.js";
import { openVmUsage } from "../src/vm-usage.js";
import { clerkToken, hostedMode, stubHostedEnv } from "./fixtures/clerk-token.js";

/**
 * Run limits (docs/spec/path-website.md §8): each user gets 2 h of VM time per rolling 24 h and
 * 1 GB of storage, and the host refuses every launch below 5 GB of free disk. `.path/limits.json`
 * overrides the per-user limits, including to 0.
 */

const GIB = 1024 * 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const ALICE = "user_alice";
const BOB = "user_bob";

let projectDir: string;
let shippedDir: string;
let handle: PathServerHandle | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-run-limits-project-"));
  shippedDir = mkdtempSync(join(tmpdir(), "path-run-limits-shipped-"));
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

async function start(): Promise<string> {
  stubHostedEnv();
  handle = await startPathServer(projectDir, {
    shippedDir: { template: join(shippedDir, "template"), workflow: join(shippedDir, "workflow") },
    mode: hostedMode(projectDir),
  });
  return handle.url;
}

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

const workflowPath = (userId: string, name: string): string =>
  `users/${userId}/workflow/${name}.workflow.json`;

function workflow(name: string): Record<string, unknown> {
  return {
    format: "path/workflow@6",
    id: randomUUID(),
    name,
    body: [{ type: "binary", id: randomUUID(), name: "step-one", command: "true" }],
  };
}

function putWorkflow(url: string, userId: string, name: string): Promise<Response> {
  return fetch(
    `${url}/v0/workflows`,
    as(userId, "PUT", { workflow_path: workflowPath(userId, name), workflow: workflow(name) }),
  );
}

function launch(url: string, userId: string, name: string): Promise<Response> {
  return fetch(`${url}/v0/runs`, as(userId, "POST", { workflow_path: workflowPath(userId, name) }));
}

async function errorMessage(res: Response): Promise<string> {
  return ((await res.json()) as { error: { message: string } }).error.message;
}

describe("createRunLimits", () => {
  let clock: number;
  const limitsWith = (freeDiskBytes = 100 * GIB) => {
    const usage = openVmUsage(":memory:", () => clock);
    const creators = openCreatorTable(":memory:");
    const run = createRunLimits({
      projectDir,
      creators,
      usage,
      freeDiskBytes: () => freeDiskBytes,
      now: () => clock,
    });
    return { usage, run };
  };

  beforeEach(() => {
    clock = Date.UTC(2026, 9, 8, 12);
  });

  it("refuses a launch over the VM-time budget with 429 and the retry time", () => {
    const { usage, run } = limitsWith();
    const end = usage.begin(ALICE);
    clock += 2 * HOUR;
    end();

    const refused = run.launchRefusal(ALICE, DEFAULT_LIMITS);
    expect(refused?.status).toBe(429);
    expect(refused?.message).toMatch(/^budget used, try at 2026-10-09T12:00:01/);
    expect(refused?.retryAfterSeconds).toBeGreaterThan(22 * 60 * 60);
    expect(run.launchRefusal(BOB, DEFAULT_LIMITS)).toBeUndefined();
  });

  it("refuses every launch below 5 GB of free disk", () => {
    const { run } = limitsWith(5 * GIB - 1);
    const refused = run.launchRefusal(ALICE, DEFAULT_LIMITS);
    expect(refused?.status).toBe(507);
    expect(run.storageRefusal(ALICE, DEFAULT_LIMITS)).toBeUndefined();
  });

  it("refuses every launch of a user whose VM-time or VM override is 0", () => {
    const { run } = limitsWith();
    expect(run.launchRefusal(ALICE, { ...DEFAULT_LIMITS, vmSecondsPerDay: 0 })?.status).toBe(429);
    expect(run.launchRefusal(ALICE, { ...DEFAULT_LIMITS, maxRunningVms: 0 })?.status).toBe(429);
    expect(run.launchRefusal(ALICE, { ...DEFAULT_LIMITS, maxStorageBytes: 0 })?.status).toBe(507);
  });
});

describe("storage", () => {
  it("refuses launches and writes over the limit with 507, and still deletes", async () => {
    writeLimits({ users: { [ALICE]: { maxStorageBytes: 1024 * 1024 } } });
    const url = await start();
    expect((await putWorkflow(url, ALICE, "small")).status).toBe(201);
    expect((await putWorkflow(url, BOB, "small")).status).toBe(201);
    writeFileSync(join(projectDir, "users", ALICE, "filler.bin"), Buffer.alloc(2 * 1024 * 1024));

    const launched = await launch(url, ALICE, "small");
    expect(launched.status).toBe(507);
    expect(await errorMessage(launched)).toBe("storage full, delete runs");
    expect((await putWorkflow(url, ALICE, "other")).status).toBe(507);
    expect((await fetch(`${url}/v0/workflows`, as(ALICE))).status).toBe(200);
    const file = await fetch(
      `${url}/v0/workflows/file?path=${encodeURIComponent(workflowPath(ALICE, "small"))}`,
      as(ALICE),
    );
    const removed = await fetch(
      `${url}/v0/workflows/file?path=${encodeURIComponent(workflowPath(ALICE, "small"))}`,
      {
        ...as(ALICE, "DELETE"),
        headers: { ...as(ALICE).headers, "If-Match": file.headers.get("ETag") ?? "" },
      },
    );
    expect(removed.status).toBe(204);

    expect((await launch(url, BOB, "small")).status).toBe(202);
  });

  it("blocks launches of a user whose override is 0", async () => {
    writeLimits({ users: { [ALICE]: { maxRunningVms: 0 } } });
    const url = await start();
    expect((await putWorkflow(url, ALICE, "small")).status).toBe(201);
    expect((await launch(url, ALICE, "small")).status).toBe(429);
  });
});
