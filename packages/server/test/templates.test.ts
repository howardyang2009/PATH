import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

let projectDir: string;
let shippedDir: string;
let handle: PathServerHandle | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-templates-project-"));
  shippedDir = mkdtempSync(join(tmpdir(), "path-templates-shipped-"));
  handle = undefined;
});

afterEach(async () => {
  if (handle) await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(shippedDir, { recursive: true, force: true });
});

/** The strong ETag the routes hand back: sha256 of the exact bytes, hex, double-quoted. */
function strongEtag(bytes: string): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

/** A valid step-template envelope (ADR 0048): `{ format, id, description, body }`, one `binary` node. */
function stepTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "path/workflow@5",
    id: randomUUID(),
    description: "a saved step fragment",
    body: [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }],
    ...overrides,
  };
}

/** A valid workflow file (not a template kind since ADR 0063, so the template store ignores it). */
function workflowFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "path/workflow@5",
    id: randomUUID(),
    name: "nightly",
    body: [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }],
    ...overrides,
  };
}

/** Write a file into a template root's `<kindDir>`, returning its bytes on disk. */
function writeTemplate(
  root: string,
  kindDir: string,
  fileStem: string,
  suffix: string,
  content: Record<string, unknown>,
): string {
  const dir = join(root, kindDir);
  mkdirSync(dir, { recursive: true });
  const bytes = `${JSON.stringify(content, null, 2)}\n`;
  writeFileSync(join(dir, `${fileStem}${suffix}`), bytes);
  return bytes;
}

async function start(): Promise<PathServerHandle> {
  handle = await startPathServer(projectDir, 0, undefined, undefined, undefined, shippedDir);
  return handle;
}

describe("GET /v0/templates", () => {
  it("lists the shipped∪user union thin, with origin/read_only and no body", async () => {
    writeTemplate(shippedDir, "step-template", "review", ".step-template.json", stepTemplate());
    writeTemplate(projectDir + "/.path/template", "step-template", "nightly", ".step-template.json", stepTemplate());

    const { url } = await start();
    const res = await fetch(`${url}/v0/templates`);
    expect(res.status).toBe(200);
    const { templates } = (await res.json()) as { templates: Record<string, unknown>[] };

    const shipped = templates.find((t) => t.origin === "shipped")!;
    expect(shipped).toMatchObject({ name: "review", kind: "step", origin: "shipped", read_only: true, valid: true });
    expect(shipped).not.toHaveProperty("body");

    const user = templates.find((t) => t.origin === "user")!;
    expect(user).toMatchObject({ name: "nightly", kind: "step", origin: "user", read_only: false, valid: true });
  });

  it("ignores a former *.workflow-template.json file (ADR 0063: the Step-Template is the only kind)", async () => {
    writeTemplate(shippedDir, "step-template", "review", ".step-template.json", stepTemplate());
    writeTemplate(projectDir + "/.path/template", "workflow-template", "nightly", ".workflow-template.json", workflowFile());

    const { url } = await start();
    const all = (await (await fetch(`${url}/v0/templates`)).json()) as { templates: { name: string }[] };
    expect(all.templates.map((t) => t.name)).toEqual(["review"]);
    const stepOnly = (await (await fetch(`${url}/v0/templates?kind=step`)).json()) as { templates: { kind: string }[] };
    expect(stepOnly.templates.map((t) => t.kind)).toEqual(["step"]);
  });

  it("invalidates only the offending entry (unregistered step type), never the scan", async () => {
    writeTemplate(shippedDir, "step-template", "good", ".step-template.json", stepTemplate());
    writeTemplate(
      shippedDir,
      "step-template",
      "bad",
      ".step-template.json",
      stepTemplate({ body: [{ type: "no-such-type", id: randomUUID(), name: "x" }] }),
    );

    const { url } = await start();
    const { templates } = (await (await fetch(`${url}/v0/templates`)).json()) as {
      templates: { name: string; valid: boolean; error: unknown }[];
    };
    expect(templates.find((t) => t.name === "good")!.valid).toBe(true);
    const bad = templates.find((t) => t.name === "bad")!;
    expect(bad.valid).toBe(false);
    expect(bad.error).not.toBeNull();
  });

  it("lists both of a cross-origin duplicate id and flags the user one invalid", async () => {
    const id = randomUUID();
    writeTemplate(shippedDir, "step-template", "shared", ".step-template.json", stepTemplate({ id }));
    writeTemplate(projectDir + "/.path/template", "step-template", "copy", ".step-template.json", stepTemplate({ id }));

    const { url } = await start();
    const { templates } = (await (await fetch(`${url}/v0/templates`)).json()) as {
      templates: { origin: string; valid: boolean }[];
    };
    expect(templates.find((t) => t.origin === "shipped")!.valid).toBe(true);
    expect(templates.find((t) => t.origin === "user")!.valid).toBe(false);
  });
});

describe("GET /v0/templates/:id", () => {
  it("returns a parsed envelope and a byte-exact etag", async () => {
    const tpl = stepTemplate();
    const bytes = writeTemplate(shippedDir, "step-template", "review", ".step-template.json", tpl);

    const { url } = await start();
    const res = await fetch(`${url}/v0/templates/${tpl.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(strongEtag(bytes));
    expect(await res.json()).toMatchObject({
      id: tpl.id,
      name: "review",
      kind: "step",
      origin: "shipped",
      read_only: true,
      format: "path/workflow@5",
      description: "a saved step fragment",
      body: tpl.body,
      valid: true,
      error: null,
      etag: strongEtag(bytes),
    });
  });

  it("returns 200 with valid:false and the body for an invalid template", async () => {
    const tpl = stepTemplate({ body: [{ type: "no-such-type", id: randomUUID(), name: "x" }] });
    writeTemplate(shippedDir, "step-template", "bad", ".step-template.json", tpl);

    const { url } = await start();
    const res = await fetch(`${url}/v0/templates/${tpl.id}`);
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { valid: boolean; body: unknown };
    expect(parsed.valid).toBe(false);
    expect(parsed.body).toEqual(tpl.body);
  });

  it("404s an unknown id", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/v0/templates/${randomUUID()}`)).status).toBe(404);
  });
});

describe("POST /v0/templates", () => {
  it("creates a user template under .path/template and returns 201", async () => {
    const body = stepTemplate();
    const { url } = await start();
    const res = await fetch(`${url}/v0/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "step", name: "my-fragment", description: "blurb", body }),
    });
    expect(res.status).toBe(201);
    const rel = ".path/template/step-template/my-fragment.step-template.json";
    expect(await res.json()).toMatchObject({ id: body.id, relative_path: rel });
    expect(existsSync(join(projectDir, rel))).toBe(true);
  });

  it("400s kind \"workflow\": the Workflow-Template is gone (ADR 0063)", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/v0/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "workflow", name: "nightly", description: "blurb", body: workflowFile() }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(projectDir, ".path/template/workflow-template"))).toBe(false);
  });

  it("409s a name collision", async () => {
    const { url } = await start();
    const post = () =>
      fetch(`${url}/v0/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "step", name: "dup", description: "b", body: stepTemplate() }),
      });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(409);
  });

  it("400s a name that violates NameSchema", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/v0/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "step", name: "Bad Name", description: "b", body: stepTemplate() }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /v0/templates/:id", () => {
  async function seedUserStep(): Promise<{ url: string; tpl: Record<string, unknown>; etag: string }> {
    const tpl = stepTemplate();
    const bytes = writeTemplate(projectDir + "/.path/template", "step-template", "editable", ".step-template.json", tpl);
    const { url } = await start();
    return { url, tpl, etag: strongEtag(bytes) };
  }

  it("updates in place with a matching If-Match and returns 200 + new etag", async () => {
    const { url, tpl, etag } = await seedUserStep();
    const updated = { ...tpl, description: "edited" };
    const res = await fetch(`${url}/v0/templates/${tpl.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify(updated),
    });
    expect(res.status).toBe(200);
    const onDisk = readFileSync(join(projectDir, ".path/template/step-template/editable.step-template.json"), "utf8");
    expect(onDisk).toBe(`${JSON.stringify(updated, null, 2)}\n`);
    expect(res.headers.get("etag")).toBe(strongEtag(onDisk));
  });

  it("412s a stale or missing If-Match", async () => {
    const { url, tpl } = await seedUserStep();
    const noHeader = await fetch(`${url}/v0/templates/${tpl.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tpl),
    });
    expect(noHeader.status).toBe(412);
    const stale = await fetch(`${url}/v0/templates/${tpl.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": '"deadbeef"' },
      body: JSON.stringify(tpl),
    });
    expect(stale.status).toBe(412);
  });

  it("400s a body id that disagrees with the URL id", async () => {
    const { url, tpl, etag } = await seedUserStep();
    const res = await fetch(`${url}/v0/templates/${tpl.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify({ ...tpl, id: randomUUID() }),
    });
    expect(res.status).toBe(400);
  });

  it("403s a shipped template and 404s an unknown id", async () => {
    const shipped = stepTemplate();
    const bytes = writeTemplate(shippedDir, "step-template", "ro", ".step-template.json", shipped);
    const { url } = await start();
    const ro = await fetch(`${url}/v0/templates/${shipped.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": strongEtag(bytes) },
      body: JSON.stringify(shipped),
    });
    expect(ro.status).toBe(403);

    const unknown = await fetch(`${url}/v0/templates/${randomUUID()}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": '"x"' },
      body: JSON.stringify(stepTemplate()),
    });
    expect(unknown.status).toBe(404);
  });
});

describe("DELETE /v0/templates/:id", () => {
  it("removes a user template (204), 403s shipped, 404s unknown", async () => {
    const user = stepTemplate();
    writeTemplate(projectDir + "/.path/template", "step-template", "gone", ".step-template.json", user);
    const shipped = stepTemplate();
    writeTemplate(shippedDir, "step-template", "keep", ".step-template.json", shipped);
    const { url } = await start();

    const del = await fetch(`${url}/v0/templates/${user.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(existsSync(join(projectDir, ".path/template/step-template/gone.step-template.json"))).toBe(false);

    expect((await fetch(`${url}/v0/templates/${shipped.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await fetch(`${url}/v0/templates/${randomUUID()}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("the two write doors are disjoint (§10.6)", () => {
  it("PUT /v0/workflows refuses a .path/template/ path", async () => {
    const { url } = await start();
    const put = (path: string) =>
      fetch(`${url}/v0/workflows`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_path: path, workflow: workflowFile() }),
      });
    expect((await put(".path/template/step-template/nightly.workflow.json")).status).toBe(400);
  });
});
