import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

let projectDir: string;
let handle: PathServerHandle;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-put-workflow-test-"));
});

afterEach(async () => {
  if (handle) await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

/** A minimal well-formed workflow object (snake_case wire), with a distinct id per node. */
function workflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "path/workflow@3",
    id: randomUUID(),
    name: "draft",
    body: [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }],
    ...overrides,
  };
}

/** The strong ETag the route hands back: sha256 of the exact bytes, hex, double-quoted. */
function strongEtag(bytes: string): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

/** `PUT /v0/workflows` against a freshly started server. */
async function put(
  workflowPath: string,
  wf: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  handle = await startPathServer(projectDir);
  return fetch(`${handle.url}/v0/workflows`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ workflow_path: workflowPath, workflow: wf }),
  });
}

describe("PUT /v0/workflows", () => {
  it("creates a confined file and returns 201 with the new ETag in the body and header", async () => {
    const wf = workflow();
    const res = await put("draft.workflow.json", wf);

    expect(res.status).toBe(201);
    const onDisk = readFileSync(join(projectDir, "draft.workflow.json"), "utf8");
    const etag = strongEtag(onDisk);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.json()).toEqual({ relative_path: "draft.workflow.json", id: wf.id, etag });
    // Deterministic serialization: 2-space indent, trailing newline.
    expect(onDisk).toBe(`${JSON.stringify(wf, null, 2)}\n`);
  });

  it("creates a `/`-bearing nested path, making intermediate dirs", async () => {
    const res = await put("lib/deep/flow.workflow.json", workflow());
    expect(res.status).toBe(201);
    expect(readFileSync(join(projectDir, "lib/deep/flow.workflow.json"), "utf8")).toContain("path/workflow@3");
  });

  it("preserves every client-minted id unchanged (identity-agnostic, ADR 0015)", async () => {
    const wf = workflow({
      id: randomUUID(),
      body: [
        { type: "binary", id: randomUUID(), name: "a", command: "echo" },
        {
          type: "parallel",
          id: randomUUID(),
          name: "p",
          join: "collect",
          branches: [
            { type: "binary", id: randomUUID(), name: "b", command: "echo" },
            { type: "binary", id: randomUUID(), name: "c", command: "echo" },
          ],
        },
      ],
    });
    const res = await put("ids.workflow.json", wf);
    expect(res.status).toBe(201);

    const written = JSON.parse(readFileSync(join(projectDir, "ids.workflow.json"), "utf8"));
    expect(written).toEqual(wf);
  });

  it("preserves author key order on disk", async () => {
    // Keys deliberately out of schema order; the raw bytes must keep the author's order.
    const wf = {
      name: "ordered",
      body: [{ command: "echo", type: "binary", name: "s", id: randomUUID() }],
      id: randomUUID(),
      format: "path/workflow@3",
    };
    const res = await put("ordered.workflow.json", wf);
    expect(res.status).toBe(201);
    expect(readFileSync(join(projectDir, "ordered.workflow.json"), "utf8")).toBe(`${JSON.stringify(wf, null, 2)}\n`);
  });

  it("accepts an authored $env wrapper in workflow config (ADR 0012 restricts $env only in operator config)", async () => {
    const wf = workflow({ config: { api_key: { $env: "SOME_API_KEY" } } });
    const res = await put("env.workflow.json", wf);
    expect(res.status).toBe(201);
  });

  describe("precondition (If-Match)", () => {
    async function seed(relPath: string, wf: unknown): Promise<string> {
      const created = await put(relPath, wf);
      expect(created.status).toBe(201);
      await handle.close();
      return created.headers.get("etag")!;
    }

    it("overwrites with a matching If-Match and returns 200 with a fresh ETag", async () => {
      const first = workflow();
      const etag = await seed("draft.workflow.json", first);

      const next = workflow({ id: first.id, name: "draft", body: [{ type: "binary", id: randomUUID(), name: "step-two", command: "ls" }] });
      const res = await put("draft.workflow.json", next, { "If-Match": etag });
      expect(res.status).toBe(200);

      const onDisk = readFileSync(join(projectDir, "draft.workflow.json"), "utf8");
      expect(res.headers.get("etag")).toBe(strongEtag(onDisk));
      expect(onDisk).toBe(`${JSON.stringify(next, null, 2)}\n`);
    });

    it("rejects a stale If-Match with 412 and leaves the file untouched", async () => {
      const first = workflow();
      await seed("draft.workflow.json", first);
      const before = readFileSync(join(projectDir, "draft.workflow.json"), "utf8");

      const res = await put("draft.workflow.json", workflow(), { "If-Match": '"deadbeef"' });
      expect(res.status).toBe(412);
      expect(readFileSync(join(projectDir, "draft.workflow.json"), "utf8")).toBe(before);
    });

    it("rejects a create-only write (no If-Match) against an existing file with 412", async () => {
      await seed("draft.workflow.json", workflow());
      const res = await put("draft.workflow.json", workflow());
      expect(res.status).toBe(412);
    });

    it("rejects an If-Match against a file that is gone with 412", async () => {
      const res = await put("missing.workflow.json", workflow(), { "If-Match": '"whatever"' });
      expect(res.status).toBe(412);
    });

    it("rejects `If-Match: *` against an existing file (no blind-overwrite spelling, ADR 0016)", async () => {
      const first = workflow();
      await seed("draft.workflow.json", first);
      const before = readFileSync(join(projectDir, "draft.workflow.json"), "utf8");

      const res = await put("draft.workflow.json", workflow(), { "If-Match": "*" });
      expect(res.status).toBe(412);
      expect(readFileSync(join(projectDir, "draft.workflow.json"), "utf8")).toBe(before);
    });
  });

  describe("origin gate", () => {
    it("rejects a cross-origin write with 403 before touching the disk", async () => {
      const res = await put("evil.workflow.json", workflow(), { "Sec-Fetch-Site": "cross-site" });
      expect(res.status).toBe(403);
      expect(() => readFileSync(join(projectDir, "evil.workflow.json"))).toThrow();
    });
  });

  describe("confinement", () => {
    it("404s a path that escapes the project root", async () => {
      const res = await put("../outside.workflow.json", workflow());
      expect(res.status).toBe(404);
      expect(() => readFileSync(join(projectDir, "..", "outside.workflow.json"))).toThrow();
    });

    it("404s an absolute path", async () => {
      const res = await put("/tmp/escape.workflow.json", workflow());
      expect(res.status).toBe(404);
    });

    it("404s when a path component is a symlinked directory", async () => {
      const outsideDir = join(projectDir, "..", `outside-dir-${Date.now()}`);
      mkdirSync(outsideDir, { recursive: true });
      symlinkSync(outsideDir, join(projectDir, "linkdir"));
      try {
        const res = await put("linkdir/flow.workflow.json", workflow());
        expect(res.status).toBe(404);
        expect(() => readFileSync(join(outsideDir, "flow.workflow.json"))).toThrow();
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("404s when the leaf itself is a symlink (refuses to traverse it)", async () => {
      const outside = join(projectDir, "..", `outside-${Date.now()}.json`);
      writeFileSync(outside, "{}");
      symlinkSync(outside, join(projectDir, "alias.workflow.json"));
      try {
        const res = await put("alias.workflow.json", workflow(), { "If-Match": '"x"' });
        expect(res.status).toBe(404);
      } finally {
        rmSync(outside, { force: true });
      }
    });
  });

  describe("validation", () => {
    it("400s a body that is not valid JSON", async () => {
      handle = await startPathServer(projectDir);
      const res = await fetch(`${handle.url}/v0/workflows`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("400s a malformed envelope (workflow absent)", async () => {
      handle = await startPathServer(projectDir);
      const res = await fetch(`${handle.url}/v0/workflows`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_path: "x.workflow.json" }),
      });
      expect(res.status).toBe(400);
    });

    it("400s a workflow whose shape fails @path/schema", async () => {
      const res = await put("bad.workflow.json", { format: "path/workflow@3", id: randomUUID(), name: "bad", body: [] });
      expect(res.status).toBe(400);
    });

    it("400s an id-less body (PUT is strict where GET is lenient, ADR 0015)", async () => {
      const res = await put("idless.workflow.json", {
        format: "path/workflow@3",
        name: "idless",
        body: [{ type: "binary", name: "s", command: "echo" }],
      });
      expect(res.status).toBe(400);
      expect(() => readFileSync(join(projectDir, "idless.workflow.json"))).toThrow();
    });

    it("400s a body with internally-duplicate node ids, naming both offending paths", async () => {
      const collidingId = randomUUID();
      const wf = workflow({
        body: [
          { type: "binary", id: collidingId, name: "a", command: "echo" },
          { type: "binary", id: collidingId, name: "b", command: "echo" },
        ],
      });
      const res = await put("dup.workflow.json", wf);
      expect(res.status).toBe(400);

      const detail = ((await res.json()) as { error: { details: string[] } }).error.details.join("\n");
      expect(detail).toContain("body.1.id");
      expect(detail).toContain("body.0.id");
      expect(() => readFileSync(join(projectDir, "dup.workflow.json"))).toThrow();
    });

    it("400s when a node reuses the workflow's own id", async () => {
      const sharedId = randomUUID();
      const wf = workflow({ id: sharedId, body: [{ type: "binary", id: sharedId, name: "s", command: "echo" }] });
      const res = await put("selfdup.workflow.json", wf);
      expect(res.status).toBe(400);
      const detail = ((await res.json()) as { error: { details: string[] } }).error.details.join("\n");
      expect(detail).toContain("body.0.id");
      expect(detail).toContain("id already used at id");
    });
  });
});
