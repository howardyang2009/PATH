import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Admission, hostedAdmission, UNLIMITED_ADMISSION } from "../src/admission.js";
import { type CreatorTable, openCreatorTable } from "../src/creator-table.js";
import { DEFAULT_LIMITS, type UserLimits } from "../src/request-limits.js";

/**
 * Admission as one module: the request, gate and VM decisions a hosted user meets, driven through
 * the one interface the route table and the VM runs share.
 */

const GIB = 1024 * 1024 * 1024;
const ALICE = "user_alice";

let projectDir: string;
let creators: CreatorTable;
let admission: Admission | undefined;
let clock: number;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-admission-"));
  creators = openCreatorTable(":memory:");
  clock = Date.parse("2026-10-09T12:00:00Z");
});

afterEach(() => {
  admission?.close();
  admission = undefined;
  creators.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function admit(overrides: Partial<UserLimits> = {}, freeDiskBytes = 100 * GIB): Admission {
  admission = hostedAdmission({
    projectDir,
    limits: { forUser: () => ({ ...DEFAULT_LIMITS, ...overrides }) },
    creators,
    hostDb: ":memory:",
    maxVmMs: 60 * 60 * 1000,
    now: () => clock,
    freeDiskBytes: () => freeDiskBytes,
  });
  return admission;
}

function request(method: string, body = ""): IncomingMessage {
  const req = Readable.from(body === "" ? [] : [Buffer.from(body)]) as unknown as IncomingMessage;
  req.method = method;
  req.headers = {};
  return req;
}

describe("hosted admission", () => {
  it("counts requests against the rate and answers 429 with Retry-After past it", async () => {
    const limits = admit({ requestsPerMinute: 1 });
    expect(await limits.admitRequest(request("GET"), ALICE)).toMatchObject({ ok: true });
    expect(await limits.admitRequest(request("GET"), ALICE)).toMatchObject({
      ok: false,
      reply: { status: 429, headers: { "Retry-After": "60" } },
    });
  });

  it("reads the body under the cap and refuses one over it with 413", async () => {
    const limits = admit({ maxBodyBytes: 4 });
    // The body arrives as a value: the cap and the read are the same admission step.
    expect(await limits.admitRequest(request("POST", "{}"), ALICE)).toMatchObject({
      ok: true,
      body: { present: true, raw: {} },
    });
    expect(await limits.admitRequest(request("POST", "0123456789"), ALICE)).toMatchObject({
      ok: false,
      reply: { status: 413 },
    });
  });

  it("refuses a body that is not JSON before a handler sees it", async () => {
    const limits = admit({ maxBodyBytes: 1024 });
    expect(await limits.admitRequest(request("POST", "{not json"), ALICE)).toMatchObject({
      ok: false,
      reply: { status: 400 },
    });
  });

  it("gates a launch and a write on storage, and a launch on free disk", () => {
    mkdirSync(join(projectDir, "users", ALICE), { recursive: true });
    writeFileSync(join(projectDir, "users", ALICE, "blob"), "x".repeat(20));
    expect(admit({ maxStorageBytes: 10 }).gateRefusal(ALICE, "write")).toMatchObject({
      status: 507,
    });
    admission?.close();
    expect(admit({}, 1).gateRefusal(ALICE, "launch")).toMatchObject({ status: 507 });
    expect(admission?.gateRefusal(ALICE, "write")).toBeUndefined();
  });

  it("holds a queued VM to the launch limits when it starts, and meters its time", () => {
    const owner = admit({ vmSecondsPerDay: 60, maxRunningVms: 2 }).runOwner(ALICE);
    expect(owner.maxRunningVms).toBe(2);
    expect(owner.startRefusal?.()).toBeUndefined();

    const end = owner.meter?.() as () => void;
    clock += 61_000;
    end();

    expect(owner.startRefusal?.()).toMatch(/^budget used/);
    expect(admission?.gateRefusal(ALICE, "launch")).toMatchObject({
      status: 429,
      headers: { "Retry-After": expect.any(String) },
    });
  });

  it("refuses a VM's import once the user's storage is full", () => {
    const owner = admit({ maxStorageBytes: 10 }).runOwner(ALICE);
    expect(owner.importRefusal?.()).toBeUndefined();
    mkdirSync(join(projectDir, "users", ALICE), { recursive: true });
    writeFileSync(join(projectDir, "users", ALICE, "blob"), "x".repeat(20));
    expect(owner.importRefusal?.()).toBe("storage full, delete runs");
  });
});

describe("unlimited admission", () => {
  it("passes every request, gate and VM", async () => {
    expect(UNLIMITED_ADMISSION.limitsOf(ALICE)).toBeUndefined();
    // Local mode has no cap, but the body is still read as a value at the one seam.
    expect(await UNLIMITED_ADMISSION.admitRequest(request("POST", "{}"), ALICE)).toMatchObject({
      ok: true,
      body: { present: true, raw: {} },
    });
    expect(UNLIMITED_ADMISSION.gateRefusal(ALICE, "launch")).toBeUndefined();
    expect(UNLIMITED_ADMISSION.runOwner(ALICE).maxRunningVms).toBe(Number.POSITIVE_INFINITY);
  });
});
