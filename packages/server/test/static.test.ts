import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

let projectDir: string;
let staticDir: string;
let handle: PathServerHandle;

const INDEX_HTML = "<!doctype html><title>path viewer</title><div id=app></div>";
const APP_JS = "console.log('path viewer bundle');";

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "path-server-static-test-"));
  staticDir = join(projectDir, "dist");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), INDEX_HTML);
  writeFileSync(join(staticDir, "assets", "app.js"), APP_JS);
  handle = await startPathServer(projectDir, 0, staticDir);
});

afterEach(async () => {
  await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("@path/server static file serving + SPA fallback", () => {
  it("serves a built asset with the correct Content-Type", async () => {
    const res = await fetch(`${handle.url}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe(APP_JS);
  });

  it("serves index.html at the root", async () => {
    const res = await fetch(`${handle.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("SPA fallback: an unknown non-/v0 GET path returns index.html so client routes deep-link", async () => {
    const res = await fetch(`${handle.url}/runs/some-deep-link/detail`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("does not fall back to HTML for /v0 API paths — unmatched /v0 stays a JSON 404", async () => {
    const res = await fetch(`${handle.url}/v0/bogus`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBeTruthy();
  });

  it("does not swallow the cancel route: it answers JSON, never the SPA index", async () => {
    const cancelPath = `${handle.url}/v0/runs/00000000-0000-0000-0000-000000000000/cancel`;
    // The route itself, reached with a static bundle configured — a JSON 404 for an unknown run.
    const posted = await fetch(cancelPath, { method: "POST" });
    expect(posted.status).toBe(404);
    expect(posted.headers.get("content-type")).toMatch(/application\/json/);

    // And the same path under a method it doesn't serve stays inside the API namespace.
    const got = await fetch(cancelPath);
    expect(got.status).toBe(404);
    expect(got.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("does not serve files outside the static root (path traversal is rejected)", async () => {
    const res = await fetch(`${handle.url}/../../etc/passwd`);
    // Normalized away by the URL/fallback; the client never escapes the static root.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });
});
