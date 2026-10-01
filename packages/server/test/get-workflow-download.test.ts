import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";

let projectDir: string;
let shippedDir: string;
let handle: PathServerHandle | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-download-project-"));
  shippedDir = mkdtempSync(join(tmpdir(), "path-download-shipped-"));
  handle = undefined;
});

afterEach(async () => {
  if (handle) await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(shippedDir, { recursive: true, force: true });
});

function put(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

/** A workflow file whose body holds one `workflow` step per `ref`. */
function flow(name: string, refs: string[] = []): string {
  const body = refs.map((ref, i) => ({ type: "workflow", id: `${name}-${i}`, name: `c${i}`, ref }));
  return `${JSON.stringify({ format: "path/workflow@6", id: name, name, body }, null, 2)}\n`;
}

async function download(path: string, origin?: "shipped"): Promise<Response> {
  handle ??= await startPathServer(
    projectDir,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    shippedDir,
  );
  const suffix = origin === undefined ? "" : `&origin=${origin}`;
  return fetch(`${handle.url}/v0/workflows/download?path=${encodeURIComponent(path)}${suffix}`);
}

async function unzipped(res: Response): Promise<Record<string, string>> {
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, Buffer.from(bytes).toString("utf8")]),
  );
}

describe("GET /v0/workflows/download", () => {
  it("returns a ref-free workflow as its own bytes with an ETag and a file name", async () => {
    const raw = flow("solo");
    put(projectDir, "users/local/workflow/solo.workflow.json", raw);

    const res = await download("users/local/workflow/solo.workflow.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toContain('filename="solo.workflow.json"');
    expect(res.headers.get("etag")).toBe(`"${createHash("sha256").update(raw).digest("hex")}"`);
    expect(await res.text()).toBe(raw);
  });

  it("zips the transitive ref closure across user, shared and shipped, keeping refs relative", async () => {
    const parent = flow("parent", ["../../../shared/workflow/mid.workflow.json"]);
    const mid = flow("mid", ["leaf/deep.workflow.json"]);
    const deep = flow("deep");
    put(projectDir, "users/local/workflow/parent.workflow.json", parent);
    put(projectDir, "shared/workflow/mid.workflow.json", mid);
    put(projectDir, "shared/workflow/leaf/deep.workflow.json", deep);
    put(projectDir, "shared/workflow/unrelated.workflow.json", flow("unrelated"));

    const res = await download("users/local/workflow/parent.workflow.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="parent.zip"');
    expect(res.headers.get("etag")).toBeNull();
    expect(await unzipped(res)).toEqual({
      "parent/shared/workflow/leaf/deep.workflow.json": deep,
      "parent/shared/workflow/mid.workflow.json": mid,
      "parent/users/local/workflow/parent.workflow.json": parent,
    });
  });

  it("places a shipped file under shipped/workflow when the closure reaches it", async () => {
    const shippedFlow = flow("starter", ["lib/child.workflow.json"]);
    const child = flow("child");
    put(shippedDir, "starter.workflow.json", shippedFlow);
    put(shippedDir, "lib/child.workflow.json", child);

    const res = await download("starter.workflow.json", "shipped");
    expect(res.status).toBe(200);
    expect(await unzipped(res)).toEqual({
      "starter/shipped/workflow/lib/child.workflow.json": child,
      "starter/shipped/workflow/starter.workflow.json": shippedFlow,
    });
  });

  it("downloads a shipped workflow with no refs as a single file", async () => {
    const raw = flow("starter");
    put(shippedDir, "starter.workflow.json", raw);

    const res = await download("starter.workflow.json", "shipped");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(raw);
  });

  it("includes each file once and raises no error on a ref cycle", async () => {
    const a = flow("a", ["b.workflow.json"]);
    const b = flow("b", ["a.workflow.json"]);
    put(projectDir, "shared/workflow/a.workflow.json", a);
    put(projectDir, "shared/workflow/b.workflow.json", b);

    const res = await download("shared/workflow/a.workflow.json");
    expect(res.status).toBe(200);
    expect(await unzipped(res)).toEqual({
      "a/shared/workflow/a.workflow.json": a,
      "a/shared/workflow/b.workflow.json": b,
    });
  });

  it("goes byte-identical on a second download of the same closure", async () => {
    put(projectDir, "users/local/workflow/p.workflow.json", flow("p", ["c.workflow.json"]));
    put(projectDir, "users/local/workflow/c.workflow.json", flow("c"));

    const first = Buffer.from(
      await (await download("users/local/workflow/p.workflow.json")).arrayBuffer(),
    );
    const second = Buffer.from(
      await (await download("users/local/workflow/p.workflow.json")).arrayBuffer(),
    );
    expect(second.equals(first)).toBe(true);
  });

  it("includes a parseable but schema-invalid file as is", async () => {
    const odd = '{"format":"nope","body":[{"type":"mystery"}]}';
    put(projectDir, "users/local/workflow/p.workflow.json", flow("p", ["odd.workflow.json"]));
    put(projectDir, "users/local/workflow/odd.workflow.json", odd);

    const files = await unzipped(await download("users/local/workflow/p.workflow.json"));
    expect(files["p/users/local/workflow/odd.workflow.json"]).toBe(odd);
  });

  it("fails 422 listing each missing ref and the file that holds it", async () => {
    put(
      projectDir,
      "users/local/workflow/p.workflow.json",
      flow("p", ["gone.workflow.json", "also-gone.workflow.json"]),
    );

    const res = await download("users/local/workflow/p.workflow.json");
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as {
      error: { details: { ref: string; from: string; reason: string }[] };
    };
    expect(error.details).toEqual([
      {
        ref: "gone.workflow.json",
        from: "users/local/workflow/p.workflow.json",
        reason: "file not found",
      },
      {
        ref: "also-gone.workflow.json",
        from: "users/local/workflow/p.workflow.json",
        reason: "file not found",
      },
    ]);
  });

  it("fails 422 on a ref that leaves the authored workflow roots", async () => {
    put(projectDir, "outside.workflow.json", flow("outside"));
    put(
      projectDir,
      "users/local/workflow/p.workflow.json",
      flow("p", ["../../../outside.workflow.json"]),
    );

    const res = await download("users/local/workflow/p.workflow.json");
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: { details: { reason: string }[] } };
    expect(error.details[0]?.reason).toBe("outside the authored workflow roots");
  });

  it("fails 422 naming a ref'd file with bad JSON", async () => {
    put(projectDir, "users/local/workflow/p.workflow.json", flow("p", ["bad.workflow.json"]));
    put(projectDir, "users/local/workflow/bad.workflow.json", "{ not json");

    const res = await download("users/local/workflow/p.workflow.json");
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: { details: unknown[] } };
    expect(error.details).toEqual([
      {
        ref: "bad.workflow.json",
        from: "users/local/workflow/p.workflow.json",
        reason: "invalid JSON",
      },
    ]);
  });

  it("answers 404 for an unknown, unconfined, non-workflow or template path", async () => {
    put(projectDir, "users/local/template/t.step-template.json", "{}");
    put(projectDir, "notes.workflow.json", flow("notes"));

    for (const path of [
      "users/local/workflow/missing.workflow.json",
      "../escape.workflow.json",
      "notes.workflow.json",
      "users/local/template/t.step-template.json",
      "",
    ]) {
      expect((await download(path)).status).toBe(404);
    }
  });

  it("answers 404 when a shipped path is asked without origin, and 400 for an unknown origin", async () => {
    put(shippedDir, "starter.workflow.json", flow("starter"));
    expect((await download("starter.workflow.json")).status).toBe(404);

    const res = await fetch(`${handle?.url}/v0/workflows/download?path=x&origin=elsewhere`);
    expect(res.status).toBe(400);
  });
});
