import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStepPluginRegistry } from "@path/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strongEtag } from "../src/etag.js";
import {
  DEFAULT_SHIPPED_TEMPLATE_DIR,
  discoverTemplates,
  type TemplateStore,
} from "../src/template-store.js";

/**
 * The template store's own interface: an id lookup plus its own writes. These drive the store
 * directly — no HTTP, no route — because the store is the seam the doors read, and the conditional
 * write's refusals are the store's to word.
 */

const USER_TEMPLATE = {
  format: "path/workflow@6",
  id: "11111111-1111-4111-8111-111111111111",
  description: "a test template",
  body: [
    { type: "binary", id: "33333333-3333-4333-8333-333333333333", name: "one", command: "echo" },
  ],
};

let projectDir: string;
let store: TemplateStore;

async function openStore(): Promise<TemplateStore> {
  return discoverTemplates(
    projectDir,
    DEFAULT_SHIPPED_TEMPLATE_DIR,
    await loadStepPluginRegistry(),
  );
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "path-template-store-"));
  store = await openStore();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** The shipped template the read-only refusals are driven against. */
function shippedId(current: TemplateStore): string {
  const shipped = current.entries.find((entry) => entry.origin === "shipped" && entry.id !== null);
  if (!shipped?.id) throw new Error("no shipped template to drive the read-only refusals");
  return shipped.id;
}

describe("template store — create", () => {
  it("writes a user template and reports the file it made", async () => {
    const created = store.create("step", "mine", USER_TEMPLATE);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.relativePath).toBe(
      join(".path", "template", "step-template", "mine.step-template.json"),
    );
    expect(existsSync(join(projectDir, created.relativePath))).toBe(true);
  });

  it("refuses an invalid envelope as 400 with its issues, writing nothing", () => {
    const { body: _body, ...noBody } = USER_TEMPLATE;
    const refused = store.create("step", "mine", { ...noBody, name: "mine" });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.status).toBe(400);
    expect("details" in refused && refused.details?.length).toBeTruthy();
    expect(existsSync(join(projectDir, ".path", "template"))).toBe(false);
  });

  it("refuses an id another template holds as 409, naming the holder", async () => {
    store.create("step", "mine", USER_TEMPLATE);
    const reopened = await openStore();

    expect(reopened.create("step", "other", USER_TEMPLATE)).toEqual({
      ok: false,
      status: 409,
      message: `template id "${USER_TEMPLATE.id}" is already used by user template "mine"`,
    });
  });

  it("refuses a name that is taken, naming it", () => {
    expect(store.create("step", "mine", USER_TEMPLATE).ok).toBe(true);

    const again = store.create("step", "mine", USER_TEMPLATE);
    expect(again).toEqual({
      ok: false,
      status: 409,
      message: 'a step template named "mine" already exists',
    });
  });
});

describe("template store — resolve and update", () => {
  it("resolves the created id, and its entry etag is the bytes' own", async () => {
    const created = store.create("step", "mine", USER_TEMPLATE);
    if (!created.ok) throw new Error("create failed");
    const reopened = await openStore();

    const found = reopened.writable(USER_TEMPLATE.id);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.entry.name).toBe("mine");
    expect(found.entry.etag).toBe(strongEtag(readFileSync(join(projectDir, created.relativePath))));
  });

  it("requires an If-Match, and refuses a stale one", async () => {
    store.create("step", "mine", USER_TEMPLATE);
    const reopened = await openStore();

    expect(reopened.update(USER_TEMPLATE.id, USER_TEMPLATE, undefined)).toEqual({
      ok: false,
      status: 412,
      message: "precondition failed: send If-Match with the ETag you last read",
    });
    expect(reopened.update(USER_TEMPLATE.id, USER_TEMPLATE, "stale")).toEqual({
      ok: false,
      status: 412,
      message: "precondition failed: the file changed since it was read",
    });
  });

  it("overwrites under the current etag and advances it", async () => {
    const created = store.create("step", "mine", USER_TEMPLATE);
    if (!created.ok) throw new Error("create failed");
    const reopened = await openStore();

    const next = { ...USER_TEMPLATE, description: "edited" };
    const written = reopened.update(USER_TEMPLATE.id, next, created.etag);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.etag).not.toBe(created.etag);

    const after = await openStore();
    expect(after.byId.get(USER_TEMPLATE.id)?.description).toBe("edited");
  });

  it("refuses a body whose id differs from the addressed one, and an invalid envelope", async () => {
    const created = store.create("step", "mine", USER_TEMPLATE);
    if (!created.ok) throw new Error("create failed");
    const reopened = await openStore();

    const otherId = { ...USER_TEMPLATE, id: "44444444-4444-4444-8444-444444444444" };
    expect(reopened.update(USER_TEMPLATE.id, otherId, created.etag)).toEqual({
      ok: false,
      status: 400,
      message: "template id in body must match the URL id",
    });
    const invalid = reopened.update(USER_TEMPLATE.id, { ...USER_TEMPLATE, body: 1 }, created.etag);
    expect(invalid.ok === false && invalid.status).toBe(400);
  });

  it("refuses an unknown id as 404 and a shipped id as 403", async () => {
    expect(store.writable("22222222-2222-4222-8222-222222222222")).toEqual({
      ok: false,
      status: 404,
      message: "not found",
    });
    expect(store.writable(shippedId(store))).toEqual({
      ok: false,
      status: 403,
      message: "template is read-only",
    });
  });
});

describe("template store — remove", () => {
  it("removes a user template, then reads it as unknown", async () => {
    store.create("step", "mine", USER_TEMPLATE);
    const reopened = await openStore();

    expect(reopened.remove(USER_TEMPLATE.id)).toEqual({ ok: true });
    expect((await openStore()).byId.has(USER_TEMPLATE.id)).toBe(false);
    expect((await openStore()).remove(USER_TEMPLATE.id)).toEqual({
      ok: false,
      status: 404,
      message: "not found",
    });
  });

  it("never removes a shipped template", () => {
    expect(store.remove(shippedId(store))).toEqual({
      ok: false,
      status: 403,
      message: "template is read-only",
    });
  });
});
