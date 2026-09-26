import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";

let projectDir: string;
let handle: PathServerHandle;

const BYTES = `${JSON.stringify({ format: "path/workflow@5", id: randomUUID(), name: "draft", body: [] }, null, 2)}\n`;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-delete-workflow-test-"));
  writeFileSync(join(projectDir, "draft.workflow.json"), BYTES);
});

afterEach(async () => {
  if (handle) await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function strongEtag(bytes: string): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

/** Write an edit-lease marker beside `draft.workflow.json`, held by `sessionId` for `ttlMs` from now. */
function writeLease(sessionId: string, ttlMs: number): void {
  const now = Date.now();
  const lease = {
    session_id: sessionId,
    acquired_at: new Date(now).toISOString(),
    heartbeat_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
  writeFileSync(join(projectDir, "draft.workflow.json.editing"), JSON.stringify(lease));
}

/** `DELETE /v0/workflows/file` against a freshly started server. */
async function del(
  path: string,
  headers: Record<string, string> = {},
  sessionId?: string,
): Promise<Response> {
  handle = await startPathServer(projectDir);
  const query = new URLSearchParams({ path });
  if (sessionId !== undefined) query.set("session_id", sessionId);
  return fetch(`${handle.url}/v0/workflows/file?${query.toString()}`, {
    method: "DELETE",
    headers,
  });
}

describe("DELETE /v0/workflows/file", () => {
  it("deletes the file under a matching If-Match and returns 204", async () => {
    const res = await del("draft.workflow.json", { "If-Match": strongEtag(BYTES) });
    expect(res.status).toBe(204);
    expect(existsSync(join(projectDir, "draft.workflow.json"))).toBe(false);
  });

  it("refuses a delete without If-Match (412), keeping the file", async () => {
    const res = await del("draft.workflow.json");
    expect(res.status).toBe(412);
    expect(existsSync(join(projectDir, "draft.workflow.json"))).toBe(true);
  });

  it("refuses a stale If-Match (412), keeping the file", async () => {
    const res = await del("draft.workflow.json", { "If-Match": strongEtag("other bytes") });
    expect(res.status).toBe(412);
    expect(existsSync(join(projectDir, "draft.workflow.json"))).toBe(true);
  });

  it("returns 404 for a missing file or a path that escapes the root", async () => {
    expect((await del("missing.workflow.json", { "If-Match": strongEtag(BYTES) })).status).toBe(
      404,
    );
    await handle.close();
    expect((await del("../outside.workflow.json", { "If-Match": strongEtag(BYTES) })).status).toBe(
      404,
    );
  });

  it("refuses a template path (400)", async () => {
    mkdirSync(join(projectDir, ".path", "template"), { recursive: true });
    const res = await del(".path/template/step-template/x.step-template.json", {
      "If-Match": strongEtag(BYTES),
    });
    expect(res.status).toBe(400);
  });

  it("refuses while another session holds a live lease (409), keeping the file", async () => {
    writeLease(randomUUID(), 30_000);
    const res = await del("draft.workflow.json", { "If-Match": strongEtag(BYTES) }, randomUUID());
    expect(res.status).toBe(409);
    expect(existsSync(join(projectDir, "draft.workflow.json"))).toBe(true);
  });

  it("deletes under the caller's own lease and removes the lease marker too", async () => {
    const mine = randomUUID();
    writeLease(mine, 30_000);
    const res = await del("draft.workflow.json", { "If-Match": strongEtag(BYTES) }, mine);
    expect(res.status).toBe(204);
    expect(existsSync(join(projectDir, "draft.workflow.json"))).toBe(false);
    expect(existsSync(join(projectDir, "draft.workflow.json.editing"))).toBe(false);
  });

  it("deletes past another session's expired lease", async () => {
    writeLease(randomUUID(), -1_000);
    const res = await del("draft.workflow.json", { "If-Match": strongEtag(BYTES) }, randomUUID());
    expect(res.status).toBe(204);
  });
});
