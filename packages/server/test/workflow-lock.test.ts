import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

let projectDir: string;
let handle: PathServerHandle;

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "path-workflow-lock-test-"));
  handle = await startPathServer(projectDir);
});

afterEach(async () => {
  if (handle) await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

const MARKER = "draft.workflow.json.editing";

/** The lease JSON the server authors and returns (typed so `noUncheckedIndexedAccess` reads fields as `string`). */
interface LeaseJson {
  session_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

/** POST a lock route with a JSON body, returning the raw `Response`. */
function post(route: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${handle.url}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const acquire = (body: Record<string, unknown>) => post("/v0/workflows/lock", body);
const heartbeat = (body: Record<string, unknown>) => post("/v0/workflows/lock/heartbeat", body);
const release = (body: Record<string, unknown>) => post("/v0/workflows/lock/release", body);

/** The lease shape the server authors, with the four server-owned fields. */
function expectLeaseShape(lease: LeaseJson, sessionId: string): void {
  expect(lease.session_id).toBe(sessionId);
  expect(typeof lease.acquired_at).toBe("string");
  expect(typeof lease.heartbeat_at).toBe("string");
  expect(typeof lease.expires_at).toBe("string");
  // `expires_at = heartbeat_at + 30s TTL`, server-computed.
  expect(Date.parse(lease.expires_at) - Date.parse(lease.heartbeat_at)).toBe(30_000);
}

describe("POST /v0/workflows/lock (acquire)", () => {
  it("grants on a free file: 200 + lease, marker written to disk", async () => {
    const sid = randomUUID();
    const res = await acquire({ workflow_path: "draft.workflow.json", session_id: sid });

    expect(res.status).toBe(200);
    const lease = (await res.json()) as LeaseJson;
    expectLeaseShape(lease, sid);

    const onDisk = JSON.parse(readFileSync(join(projectDir, MARKER), "utf8"));
    expect(onDisk).toEqual(lease);
    // Deterministic serialization: 2-space indent, trailing newline (matches the write door).
    expect(readFileSync(join(projectDir, MARKER), "utf8")).toBe(`${JSON.stringify(lease, null, 2)}\n`);
  });

  it("never trusts a client-supplied expiry: extra body fields are rejected", async () => {
    const res = await acquire({
      workflow_path: "draft.workflow.json",
      session_id: randomUUID(),
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(400);
  });

  it("re-acquire by the same live holder keeps acquired_at, refreshes expiry", async () => {
    const sid = randomUUID();
    const first = (await (await acquire({ workflow_path: "draft.workflow.json", session_id: sid })).json()) as LeaseJson;
    await new Promise((r) => setTimeout(r, 5));
    const second = (await (await acquire({ workflow_path: "draft.workflow.json", session_id: sid })).json()) as LeaseJson;

    expect(second.acquired_at).toBe(first.acquired_at);
    expect(Date.parse(second.expires_at)).toBeGreaterThanOrEqual(Date.parse(first.expires_at));
  });

  it("rejects a second session on a live marker: 409 + held_by_other + expires_at", async () => {
    const holder = (await (await acquire({ workflow_path: "draft.workflow.json", session_id: randomUUID() })).json()) as LeaseJson;

    const res = await acquire({ workflow_path: "draft.workflow.json", session_id: randomUUID() });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.held_by_other).toBe(true);
    expect(body.expires_at).toBe(holder.expires_at);
  });

  it("reclaims an expired marker on the next acquire (lazy, no background job)", async () => {
    const other = randomUUID();
    // Author a marker that expired in the past, held by another session.
    writeFileSync(
      join(projectDir, MARKER),
      JSON.stringify({
        session_id: other,
        acquired_at: "2000-01-01T00:00:00.000Z",
        heartbeat_at: "2000-01-01T00:00:00.000Z",
        expires_at: "2000-01-01T00:00:30.000Z",
      }),
    );

    const mine = randomUUID();
    const res = await acquire({ workflow_path: "draft.workflow.json", session_id: mine });
    expect(res.status).toBe(200);
    const lease = (await res.json()) as LeaseJson;
    expect(lease.session_id).toBe(mine);
    expect(Date.parse(lease.expires_at)).toBeGreaterThan(Date.now());
  });

  it("reclaims a corrupt (unparseable) marker on the next acquire", async () => {
    writeFileSync(join(projectDir, MARKER), "{ this is not valid lease json");

    const mine = randomUUID();
    const res = await acquire({ workflow_path: "draft.workflow.json", session_id: mine });
    expect(res.status).toBe(200);
    const lease = (await res.json()) as LeaseJson;
    expect(lease.session_id).toBe(mine);
    // The corrupt bytes were overwritten with a well-formed lease.
    expect(JSON.parse(readFileSync(join(projectDir, MARKER), "utf8"))).toEqual(lease);
  });

  it("takeover overwrites a live marker unconditionally: 200", async () => {
    const holder = randomUUID();
    await acquire({ workflow_path: "draft.workflow.json", session_id: holder });

    const taker = randomUUID();
    const res = await acquire({ workflow_path: "draft.workflow.json", session_id: taker, takeover: true });
    expect(res.status).toBe(200);
    const lease = (await res.json()) as LeaseJson;
    expect(lease.session_id).toBe(taker);

    // The evicted session's next heartbeat fails: someone else holds the marker now.
    const beat = await heartbeat({ workflow_path: "draft.workflow.json", session_id: holder });
    expect(beat.status).toBe(409);
  });
});

describe("POST /v0/workflows/lock/heartbeat (renew)", () => {
  it("renews for the holder: 200 + fresh heartbeat_at/expires_at, acquired_at preserved", async () => {
    const sid = randomUUID();
    const granted = (await (await acquire({ workflow_path: "draft.workflow.json", session_id: sid })).json()) as LeaseJson;
    await new Promise((r) => setTimeout(r, 5));

    const res = await heartbeat({ workflow_path: "draft.workflow.json", session_id: sid });
    expect(res.status).toBe(200);
    const renewed = (await res.json()) as LeaseJson;
    expect(renewed.acquired_at).toBe(granted.acquired_at);
    expect(Date.parse(renewed.heartbeat_at)).toBeGreaterThanOrEqual(Date.parse(granted.heartbeat_at));
    expect(Date.parse(renewed.expires_at)).toBeGreaterThanOrEqual(Date.parse(granted.expires_at));
  });

  it("409s when no marker exists", async () => {
    const res = await heartbeat({ workflow_path: "draft.workflow.json", session_id: randomUUID() });
    expect(res.status).toBe(409);
  });

  it("409s under a different session_id", async () => {
    await acquire({ workflow_path: "draft.workflow.json", session_id: randomUUID() });
    const res = await heartbeat({ workflow_path: "draft.workflow.json", session_id: randomUUID() });
    expect(res.status).toBe(409);
  });
});

describe("POST /v0/workflows/lock/release (free)", () => {
  it("deletes the marker for the holder: 200 released, file gone", async () => {
    const sid = randomUUID();
    await acquire({ workflow_path: "draft.workflow.json", session_id: sid });

    const res = await release({ workflow_path: "draft.workflow.json", session_id: sid });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: true });
    expect(existsSync(join(projectDir, MARKER))).toBe(false);
  });

  it("is idempotent: releasing an absent marker is 200", async () => {
    const res = await release({ workflow_path: "draft.workflow.json", session_id: randomUUID() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: false });
  });

  it("refuses to delete another session's marker", async () => {
    const holder = randomUUID();
    await acquire({ workflow_path: "draft.workflow.json", session_id: holder });

    const res = await release({ workflow_path: "draft.workflow.json", session_id: randomUUID() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: false });
    // The holder's marker survives.
    expect(existsSync(join(projectDir, MARKER))).toBe(true);
  });
});

describe("edit-lock confinement and origin gate", () => {
  it("404s a path that escapes the project root", async () => {
    for (const route of ["/v0/workflows/lock", "/v0/workflows/lock/heartbeat", "/v0/workflows/lock/release"]) {
      const res = await post(route, { workflow_path: "../escape.workflow.json", session_id: randomUUID() });
      expect(res.status).toBe(404);
    }
  });

  it("404s an absolute path", async () => {
    const res = await acquire({ workflow_path: "/etc/passwd", session_id: randomUUID() });
    expect(res.status).toBe(404);
  });

  it("404s when the marker's parent traverses a symlink", async () => {
    const outside = mkdtempSync(join(tmpdir(), "path-lock-outside-"));
    symlinkSync(outside, join(projectDir, "linked"));
    try {
      const res = await acquire({ workflow_path: "linked/draft.workflow.json", session_id: randomUUID() });
      expect(res.status).toBe(404);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("403s a cross-origin browser call (enforceSameOrigin)", async () => {
    const res = await post(
      "/v0/workflows/lock",
      { workflow_path: "draft.workflow.json", session_id: randomUUID() },
      { "Sec-Fetch-Site": "cross-site" },
    );
    expect(res.status).toBe(403);
  });
});
