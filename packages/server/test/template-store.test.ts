import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStepPluginRegistry } from "@path/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authoredLayout } from "../src/authored-layout.js";
import { type CreatorTable, openCreatorTable } from "../src/creator-table.js";
import { strongEtag } from "../src/etag.js";
import { discoverTemplates, type TemplateStore, templatesOf } from "../src/template-store.js";
import { writeAccess } from "../src/write-access.js";

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
let creators: CreatorTable;

/** The template union as `userId` sees it, over the one creator table. */
async function openStore(userId = "local"): Promise<TemplateStore> {
  return discoverTemplates(
    writeAccess(authoredLayout({ projectDir, userId }), creators),
    await loadStepPluginRegistry(),
  );
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "path-template-store-"));
  creators = openCreatorTable(":memory:");
  store = await openStore();
});

afterEach(() => {
  creators.close();
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
      join("users", "local", "template", "mine.step-template.json"),
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
    expect(existsSync(join(projectDir, "users"))).toBe(false);
  });

  it("refuses an id another template holds as 409, naming the holder", async () => {
    store.create("step", "mine", USER_TEMPLATE);
    const reopened = await openStore();

    expect(reopened.create("step", "other", USER_TEMPLATE)).toEqual({
      ok: false,
      status: 409,
      code: "template.id-taken",
      params: { id: USER_TEMPLATE.id, origin: "user", name: "mine" },
    });
  });

  it("refuses a name that is taken, naming it", () => {
    expect(store.create("step", "mine", USER_TEMPLATE).ok).toBe(true);

    const again = store.create("step", "mine", USER_TEMPLATE);
    expect(again).toEqual({
      ok: false,
      status: 409,
      code: "template.name-taken",
      params: { kind: "step", name: "mine" },
    });
  });
});

describe("template store — list", () => {
  it("lists every summary and the writable roots with their folders, the user's first", async () => {
    store.create("step", "mine", USER_TEMPLATE, "team/gates");
    mkdirSync(join(projectDir, "users", "local", "template", "empty"), { recursive: true });
    const listed = (await openStore()).list();

    expect(listed.templates.find((t) => t.origin === "user")).toMatchObject({
      name: "mine",
      folder: "team/gates",
      read_only: false,
    });
    expect(listed.templates.some((t) => t.origin === "shipped")).toBe(true);
    expect(listed.roots).toEqual([
      {
        origin: "user",
        relative_path: join("users", "local", "template"),
        folders: ["empty", "team", "team/gates"],
      },
      { origin: "shared", relative_path: join("shared", "template"), folders: [] },
    ]);
    expect(listed.max_file_bytes).toBeNull();
  });
});

describe("template store — resolve and update", () => {
  it("resolves the created id, and its entry etag is the bytes' own", async () => {
    const created = store.create("step", "mine", USER_TEMPLATE);
    if (!created.ok) throw new Error("create failed");
    const reopened = await openStore();

    const found = reopened.find(USER_TEMPLATE.id);
    expect(found?.name).toBe("mine");
    expect(found?.etag).toBe(strongEtag(readFileSync(join(projectDir, created.relativePath))));
  });

  it("requires an If-Match, and refuses a stale one", async () => {
    store.create("step", "mine", USER_TEMPLATE);
    const reopened = await openStore();

    expect(reopened.update(USER_TEMPLATE.id, USER_TEMPLATE, undefined)).toEqual({
      ok: false,
      status: 412,
      code: "file.precondition.required",
    });
    expect(reopened.update(USER_TEMPLATE.id, USER_TEMPLATE, "stale")).toEqual({
      ok: false,
      status: 412,
      code: "file.precondition.changed",
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
    expect(after.find(USER_TEMPLATE.id)?.description).toBe("edited");
  });

  it("refuses a body whose id differs from the addressed one, and an invalid envelope", async () => {
    const created = store.create("step", "mine", USER_TEMPLATE);
    if (!created.ok) throw new Error("create failed");
    const reopened = await openStore();

    const otherId = { ...USER_TEMPLATE, id: "44444444-4444-4444-8444-444444444444" };
    expect(reopened.update(USER_TEMPLATE.id, otherId, created.etag)).toEqual({
      ok: false,
      status: 400,
      code: "template.id-mismatch",
    });
    const invalid = reopened.update(USER_TEMPLATE.id, { ...USER_TEMPLATE, body: 1 }, created.etag);
    expect(invalid.ok === false && invalid.status).toBe(400);
  });

  it("refuses an unknown id as 404 and a shipped id as 403", async () => {
    const unknown = { ...USER_TEMPLATE, id: "22222222-2222-4222-8222-222222222222" };
    expect(store.update(unknown.id, unknown, "etag")).toEqual({
      ok: false,
      status: 404,
      code: "request.not-found",
    });
    const shipped = shippedId(store);
    expect(store.update(shipped, { ...USER_TEMPLATE, id: shipped }, "etag")).toEqual({
      ok: false,
      status: 403,
      code: "template.read-only",
    });
  });
});

describe("template store — remove", () => {
  it("removes a user template, then reads it as unknown", async () => {
    store.create("step", "mine", USER_TEMPLATE);
    const reopened = await openStore();

    expect(reopened.remove(USER_TEMPLATE.id)).toEqual({ ok: true });
    expect((await openStore()).find(USER_TEMPLATE.id) !== undefined).toBe(false);
    expect((await openStore()).remove(USER_TEMPLATE.id)).toEqual({
      ok: false,
      status: 404,
      code: "request.not-found",
    });
  });

  it("never removes a shipped template", () => {
    expect(store.remove(shippedId(store))).toEqual({
      ok: false,
      status: 403,
      code: "template.read-only",
    });
  });
});

describe("template store — shared items", () => {
  const SHARED = "shared/template/team.step-template.json";

  it("stamps the creator on a shared create; only the creator updates or removes it", async () => {
    const created = (await openStore("user_alice")).create(
      "step",
      "team",
      USER_TEMPLATE,
      undefined,
      "shared",
    );
    if (!created.ok) throw new Error("create failed");
    expect(creators.creatorOf(SHARED, "template")).toBe("user_alice");

    const bob = await openStore("user_bob");
    expect(bob.find(USER_TEMPLATE.id)?.readOnly).toBe(true);
    const refused = { ok: false, status: 403, code: "authored.shared-read-only" };
    expect(bob.update(USER_TEMPLATE.id, USER_TEMPLATE, created.etag)).toEqual(refused);
    expect(bob.remove(USER_TEMPLATE.id)).toEqual(refused);

    const alice = await openStore("user_alice");
    expect(alice.find(USER_TEMPLATE.id)?.readOnly).toBe(false);
    expect(alice.update(USER_TEMPLATE.id, USER_TEMPLATE, created.etag).ok).toBe(true);
    expect(creators.creatorOf(SHARED, "template")).toBe("user_alice");
    expect(alice.remove(USER_TEMPLATE.id)).toEqual({ ok: true });
    expect(creators.creatorOf(SHARED, "template")).toBeUndefined();
  });

  it("lists a shared template with no creator row as read-only for everyone", async () => {
    mkdirSync(join(projectDir, "shared", "template"), { recursive: true });
    writeFileSync(join(projectDir, SHARED), JSON.stringify(USER_TEMPLATE));

    const reopened = await openStore();
    expect(reopened.find(USER_TEMPLATE.id)?.readOnly).toBe(true);
    expect(reopened.remove(USER_TEMPLATE.id)).toMatchObject({ ok: false, status: 403 });
    expect(existsSync(join(projectDir, SHARED))).toBe(true);
  });
});

describe("templatesOf — one scan per request context", () => {
  it("hands the same store back for one context, and a fresh one per context", async () => {
    const layout = authoredLayout({ projectDir, userId: "local" });
    const stepPlugins = await loadStepPluginRegistry();
    const ctx = { access: writeAccess(layout, creators), stepPlugins };

    expect(templatesOf(ctx)).toBe(templatesOf(ctx));
    expect(templatesOf({ ...ctx })).not.toBe(templatesOf(ctx));
  });
});
