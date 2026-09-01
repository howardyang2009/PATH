import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

let projectDir: string;
let staticDir: string;
let designerDir: string;
let handle: PathServerHandle;

const INDEX_HTML = "<!doctype html><title>path viewer</title><div id=app></div>";
const APP_JS = "console.log('path viewer bundle');";
const DESIGNER_INDEX_HTML = "<!doctype html><title>path designer</title><div id=app></div>";
const DESIGNER_APP_JS = "console.log('path designer bundle');";

/** Starts the server with the Viewer built and the Designer dir chosen by `withDesigner`. */
async function start(withDesigner: boolean): Promise<PathServerHandle> {
  return startPathServer(projectDir, 0, staticDir, withDesigner ? designerDir : join(projectDir, "no-designer"));
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "path-server-static-test-"));
  staticDir = join(projectDir, "dist");
  designerDir = join(projectDir, "designer-dist");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), INDEX_HTML);
  writeFileSync(join(staticDir, "assets", "app.js"), APP_JS);
  mkdirSync(join(designerDir, "assets"), { recursive: true });
  writeFileSync(join(designerDir, "index.html"), DESIGNER_INDEX_HTML);
  writeFileSync(join(designerDir, "assets", "app.js"), DESIGNER_APP_JS);
  handle = await start(false);
});

afterEach(async () => {
  await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("@path/server named mounts + per-mount SPA fallback", () => {
  it("GET / redirects (302) to /viewer/ so the default surface stays a changeable line", async () => {
    const res = await fetch(`${handle.url}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/viewer/");
  });

  it("serves the Viewer index.html at the mount root /viewer/", async () => {
    const res = await fetch(`${handle.url}/viewer/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("bare /viewer (no trailing slash) also maps to the Viewer index.html", async () => {
    const res = await fetch(`${handle.url}/viewer`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("serves a built Viewer asset under the prefix with the correct Content-Type", async () => {
    const res = await fetch(`${handle.url}/viewer/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe(APP_JS);
  });

  it("SPA fallback is per-mount: an unknown /viewer/* path returns the Viewer index.html", async () => {
    const res = await fetch(`${handle.url}/viewer/runs/some-deep-link/detail`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("the Designer mount 404s while its bundle is unbuilt (degrades, never crashes)", async () => {
    for (const path of ["/designer", "/designer/", "/designer/assets/app.js"]) {
      const res = await fetch(`${handle.url}${path}`);
      expect(res.status).toBe(404);
    }
  });

  it("an unbuilt Designer mount never falls back to the Viewer index.html", async () => {
    const res = await fetch(`${handle.url}/designer/`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toBe(INDEX_HTML);
  });

  it("a non-prefixed, non-/v0 path is a plain 404 (not the SPA index)", async () => {
    const res = await fetch(`${handle.url}/runs/some-deep-link/detail`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toBe(INDEX_HTML);
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

  it("does not serve files outside a mount root (path traversal is rejected)", async () => {
    // The URL normalizes the `..` segments away to `/etc/passwd` before they reach a mount, so the
    // request is a plain non-prefixed 404 — the client never escapes the static root.
    const res = await fetch(`${handle.url}/viewer/../../../etc/passwd`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("root:");
  });
});

describe("@path/server with the Designer bundle built", () => {
  beforeEach(async () => {
    await handle.close();
    handle = await start(true);
  });

  it("serves the Designer index.html at /designer/ and bare /designer", async () => {
    for (const path of ["/designer/", "/designer"]) {
      const res = await fetch(`${handle.url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(await res.text()).toBe(DESIGNER_INDEX_HTML);
    }
  });

  it("serves a Designer asset under its own prefix, not the Viewer's", async () => {
    const res = await fetch(`${handle.url}/designer/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DESIGNER_APP_JS);
  });

  it("each mount's SPA fallback serves its own index.html", async () => {
    const viewer = await fetch(`${handle.url}/viewer/deep/link`);
    expect(await viewer.text()).toBe(INDEX_HTML);
    const designer = await fetch(`${handle.url}/designer/deep/link`);
    expect(await designer.text()).toBe(DESIGNER_INDEX_HTML);
  });
});
