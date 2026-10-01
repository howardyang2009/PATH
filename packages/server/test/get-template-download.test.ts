import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";

let projectDir: string;
let shippedDir: string;
let handle: PathServerHandle;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-tdownload-project-"));
  shippedDir = mkdtempSync(join(tmpdir(), "path-tdownload-shipped-"));
});

afterEach(async () => {
  await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(shippedDir, { recursive: true, force: true });
});

function put(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

async function download(id: string): Promise<Response> {
  handle = await startPathServer(
    projectDir,
    0,
    undefined,
    undefined,
    undefined,
    shippedDir,
    undefined,
  );
  return fetch(`${handle.url}/v0/templates/${id}/download`);
}

describe("GET /v0/templates/:id/download", () => {
  it("returns a user template's on-disk bytes under its file name", async () => {
    const raw = '{"format":"path/workflow@6","id":"t-user","description":"d","body":[]}';
    put(projectDir, "users/local/template/mine.step-template.json", raw);

    const res = await download("t-user");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toContain('filename="mine.step-template.json"');
    expect(await res.text()).toBe(raw);
  });

  it("returns a shipped template, and an invalid one, as they are", async () => {
    put(shippedDir, "stock.step-template.json", '{"id":"t-ship","format":"nope"}');

    const res = await download("t-ship");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"id":"t-ship","format":"nope"}');
  });

  it("answers 404 for an unknown id", async () => {
    expect((await download("nope")).status).toBe(404);
  });
});
