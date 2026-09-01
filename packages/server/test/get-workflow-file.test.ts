import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

let projectDir: string;
let handle: PathServerHandle;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-workflow-file-test-"));
});

afterEach(async () => {
  if (handle) await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const abs = join(projectDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

/** `GET /v0/workflows/file?path=<path>` against the started server. */
async function readFile(path: string): Promise<Response> {
  handle = await startPathServer(projectDir);
  return fetch(`${handle.url}/v0/workflows/file?path=${encodeURIComponent(path)}`);
}

/** The strong ETag the route must hand back: the sha256 of the exact bytes, hex, double-quoted. */
function strongEtag(bytes: string): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

describe("GET /v0/workflows/file", () => {
  it("returns the file's raw bytes verbatim with a strong ETag and JSON content-type", async () => {
    // Odd whitespace and an unknown top-level field: the route must preserve both byte-for-byte
    // (it never parses or re-serializes — server-api-v0.md §7.1).
    const raw = '{\n  "format": "path/workflow@3",\n  "id": "x",\n  "keep_me": [1,2,3],\n  "name":"solo"\n}\n';
    write("solo.workflow.json", raw);

    const res = await readFile("solo.workflow.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("etag")).toBe(strongEtag(raw));
    expect(await res.text()).toBe(raw);
  });

  it("resolves a `/`-bearing nested path", async () => {
    const raw = '{"format":"path/workflow@3","id":"y","name":"nested"}';
    write("lib/deep/flow.workflow.json", raw);

    const res = await readFile("lib/deep/flow.workflow.json");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(raw);
  });

  it("serves an id-less-but-otherwise-valid file rather than rejecting it (ADR 0015)", async () => {
    // No `id` field. The read route never runs the loader, so it hands back the bytes untouched;
    // stamp-on-import is the client's job.
    const raw = '{"format":"path/workflow@3","name":"draft","body":[{"type":"binary","name":"s","command":"echo"}]}';
    write("draft.workflow.json", raw);

    const res = await readFile("draft.workflow.json");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(raw);
  });

  it("404s a file that is not on disk", async () => {
    const res = await readFile("missing.workflow.json");
    expect(res.status).toBe(404);
  });

  it("404s a path that escapes the project root", async () => {
    // A sibling file just outside the root: reachable lexically via `..`, refused by confinement.
    writeFileSync(join(projectDir, "..", "outside.json"), '{"secret":true}');
    try {
      const res = await readFile("../outside.json");
      expect(res.status).toBe(404);
    } finally {
      rmSync(join(projectDir, "..", "outside.json"), { force: true });
    }
  });

  it("404s an absolute path that escapes the root", async () => {
    const res = await readFile("/etc/hostname");
    expect(res.status).toBe(404);
  });

  it("404s when a symlinked file would redirect the read outside the root", async () => {
    const outside = join(projectDir, "..", `outside-${Date.now()}.json`);
    writeFileSync(outside, '{"secret":true}');
    symlinkSync(outside, join(projectDir, "alias.workflow.json"));
    try {
      const res = await readFile("alias.workflow.json");
      expect(res.status).toBe(404);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("404s when a path component is a symlinked directory", async () => {
    // A symlinked parent dir could otherwise redirect the read outside the root even when the
    // lexical path stays inside (server-api-v0.md §7, same confinement §7.1).
    const outsideDir = join(projectDir, "..", `outside-dir-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret.workflow.json"), '{"secret":true}');
    symlinkSync(outsideDir, join(projectDir, "linkdir"));
    try {
      const res = await readFile("linkdir/secret.workflow.json");
      expect(res.status).toBe(404);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("404s a missing `path` query param", async () => {
    handle = await startPathServer(projectDir);
    const res = await fetch(`${handle.url}/v0/workflows/file`);
    expect(res.status).toBe(404);
  });
});
