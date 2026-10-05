import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProject, type Project } from "@path/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../src/authored-layout.js";
import {
  createRequesterContexts,
  type RequesterContext,
  type RequesterContexts,
} from "../src/requester.js";

/**
 * The requester context one request is handled under (ADR 0088): the resolved user id, that user's
 * authored layout and that user's store. Local mode resolves every request to `local`, and one
 * context per user is kept rather than rebuilt per request.
 */

let projectDir: string;
let projectStore: Project;

/** The id a request acts for is the only thing the resolver reads off the request. */
const REQUEST = {} as IncomingMessage;

/** The context `REQUEST` resolves to; every resolver here proves an identity. */
async function forRequest(contexts: RequesterContexts): Promise<RequesterContext> {
  const context = await contexts.forRequest(REQUEST);
  if (context === undefined) throw new Error("expected a requester context");
  return context;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-requester-test-"));
  const opened = openProject(projectDir);
  if (!opened.success) throw new Error(opened.error);
  projectStore = opened.project;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("createRequesterContexts", () => {
  it("resolves every request to local and the project's own store", async () => {
    const contexts = createRequesterContexts({ projectDir, projectStore });

    const context = await forRequest(contexts);

    expect(context.userId).toBe(DEFAULT_USER_ID);
    expect(context.store).toBe(projectStore);
    expect(context.layout.root("user", "workflow").dir).toBe(
      join(resolve(projectDir), "users", DEFAULT_USER_ID, "workflow"),
    );
    contexts.close();
  });

  it("reuses one store across a user's requests", async () => {
    const contexts = createRequesterContexts({ projectDir, projectStore });

    const first = await forRequest(contexts);
    const second = await forRequest(contexts);

    expect(second).toBe(first);
    expect(second.store).toBe(first.store);
    contexts.close();
  });

  it("keeps a resolved id's own layout, on the project's store", async () => {
    const contexts = createRequesterContexts({
      projectDir,
      projectStore,
      resolveUserId: () => "user_abc",
    });

    const first = await forRequest(contexts);
    const second = await forRequest(contexts);

    expect(first.userId).toBe("user_abc");
    expect(first.layout.root("user", "workflow").dir).toBe(
      join(resolve(projectDir), "users", "user_abc", "workflow"),
    );
    expect(first.store).toBe(projectStore);
    expect(second).toBe(first);
    contexts.close();
  });

  it("resolves no context when the request proves no identity", async () => {
    const contexts = createRequesterContexts({
      projectDir,
      projectStore,
      resolveUserId: () => undefined,
    });

    expect(await contexts.forRequest(REQUEST)).toBeUndefined();
    contexts.close();
  });

  it("closes the stores it holds", async () => {
    const contexts = createRequesterContexts({ projectDir, projectStore });
    await contexts.forRequest(REQUEST);

    contexts.close();

    expect(() => projectStore.archive.listRoots()).toThrow();
  });
});
