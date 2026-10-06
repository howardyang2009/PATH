import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openProject } from "@path/engine";
import type { ListWorkflowsResponse } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { clerkToken, stubHostedEnv } from "./fixtures/clerk-token.js";

/**
 * The requester's view in hosted mode (ADR 0088 §1, §2, §6): each request sees shipped, shared and
 * its own user root, another user's path answers `404` on every workflow door, and a ref outside
 * the launcher's view fails the load. Local mode keeps following paths anywhere.
 */

const ALICE = "user_alice";
const BOB = "user_bob";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let projectDir: string;
let shippedDir: string;
let handle: PathServerHandle | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-requester-view-project-"));
  shippedDir = mkdtempSync(join(tmpdir(), "path-requester-view-shipped-"));
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(shippedDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function start({ hosted }: { hosted: boolean }): Promise<string> {
  if (hosted) stubHostedEnv();
  handle = await startPathServer(
    projectDir,
    0,
    undefined,
    undefined,
    undefined,
    join(shippedDir, "template"),
    join(shippedDir, "workflow"),
  );
  return handle.url;
}

/** Writes `content` as JSON at the project path `relPath`, returning `relPath`. */
function write(relPath: string, content: unknown): string {
  const abs = join(projectDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(content, null, 2)}\n`);
  return relPath;
}

function workflow(name: string, body: unknown[] = []): Record<string, unknown> {
  return {
    format: "path/workflow@6",
    id: randomUUID(),
    name,
    body:
      body.length > 0
        ? body
        : [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }],
  };
}

function refStep(ref: string): Record<string, unknown> {
  return { type: "workflow", id: randomUUID(), name: "child", ref };
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

/** A request as `userId`, with an optional JSON body. */
function as(userId: string, method = "GET", body?: unknown): RequestInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${clerkToken({ sub: userId })}`,
  };
  if (body === undefined) return { method, headers };
  return {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function listedNames(url: string, userId: string): Promise<string[]> {
  const res = await fetch(`${url}/v0/workflows`, as(userId));
  expect(res.status).toBe(200);
  return ((await res.json()) as ListWorkflowsResponse).workflows.map((w) => w.name ?? "");
}

async function launch(url: string, userId: string, workflowPath: string): Promise<Response> {
  return fetch(`${url}/v0/runs`, as(userId, "POST", { workflow_path: workflowPath }));
}

interface RunTree {
  status: string;
  runs: { run_id: string; status: string }[];
}

/** Polls the run tree, as `userId`, until `done` holds for it. */
async function waitFor(
  url: string,
  userId: string,
  rootRunId: string,
  done: (tree: RunTree) => boolean,
): Promise<RunTree> {
  for (let i = 0; i < 100; i++) {
    const tree = (await (await fetch(`${url}/v0/runs/${rootRunId}`, as(userId))).json()) as RunTree;
    if (done(tree)) return tree;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${rootRunId} never reached the expected state`);
}

describe("the requester's view in hosted mode", () => {
  it("lists only shipped, shared and the requester's own workflows and templates", async () => {
    mkdirSync(join(shippedDir, "workflow"), { recursive: true });
    writeFileSync(
      join(shippedDir, "workflow", "starter.workflow.json"),
      JSON.stringify(workflow("starter")),
    );
    write("shared/workflow/team.workflow.json", workflow("team"));
    write(`users/${ALICE}/workflow/alice.workflow.json`, workflow("alice"));
    write(`users/${BOB}/workflow/bob.workflow.json`, workflow("bob"));
    const template = (description: string) => ({
      format: "path/workflow@6",
      id: randomUUID(),
      description,
      body: [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }],
    });
    write(`users/${ALICE}/template/a.step-template.json`, template("alice's"));
    write(`users/${BOB}/template/b.step-template.json`, template("bob's"));
    const url = await start({ hosted: true });

    expect((await listedNames(url, ALICE)).sort()).toEqual(["alice", "starter", "team"]);
    expect((await listedNames(url, BOB)).sort()).toEqual(["bob", "starter", "team"]);
    const templates = await fetch(`${url}/v0/templates`, as(ALICE));
    const names = ((await templates.json()) as { templates: { name: string }[] }).templates.map(
      (t) => t.name,
    );
    expect(names).toEqual(["a"]);
  });

  it("lets two users keep the same template id in their private roots", async () => {
    const id = randomUUID();
    const template = {
      format: "path/workflow@6",
      id,
      description: "same id",
      body: [{ type: "binary", id: randomUUID(), name: "step-one", command: "echo" }],
    };
    write(`users/${ALICE}/template/mine.step-template.json`, template);
    write(`users/${BOB}/template/mine.step-template.json`, template);
    const url = await start({ hosted: true });

    for (const user of [ALICE, BOB]) {
      const res = await fetch(`${url}/v0/templates`, as(user));
      const { templates } = (await res.json()) as { templates: { id: string; valid: boolean }[] };
      expect(templates).toEqual([expect.objectContaining({ id, valid: true })]);
    }
  });

  it("answers 404 on every workflow door for another user's path", async () => {
    const bobs = write(`users/${BOB}/workflow/bob.workflow.json`, workflow("bob"));
    const url = await start({ hosted: true });
    const lock = { workflow_path: bobs, session_id: "s1" };

    const replies = await Promise.all([
      fetch(`${url}/v0/workflows/file?path=${bobs}`, as(ALICE)),
      fetch(`${url}/v0/workflows/download?path=${bobs}`, as(ALICE)),
      fetch(
        `${url}/v0/workflows`,
        as(ALICE, "PUT", { workflow_path: bobs, workflow: workflow("bob") }),
      ),
      fetch(`${url}/v0/workflows/file?path=${bobs}`, {
        ...as(ALICE, "DELETE"),
        headers: { ...as(ALICE).headers, "If-Match": '"x"' },
      }),
      launch(url, ALICE, bobs),
      fetch(`${url}/v0/workflows/lock`, as(ALICE, "POST", lock)),
      fetch(`${url}/v0/workflows/lock/heartbeat`, as(ALICE, "POST", lock)),
      fetch(`${url}/v0/workflows/lock/release`, as(ALICE, "POST", lock)),
    ]);

    expect(replies.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404]);
    // A path that does not exist in the other user's root answers the same.
    const missing = `users/${BOB}/workflow/nope.workflow.json`;
    expect((await fetch(`${url}/v0/workflows/file?path=${missing}`, as(ALICE))).status).toBe(404);
    expect(readFileSync(join(projectDir, bobs), "utf8")).toContain('"bob"');
  });

  it("answers 404 when resuming or completing a run of another user's workflow", async () => {
    const failing = write(
      `users/${BOB}/workflow/failing.workflow.json`,
      fixture("failing-step.workflow.json"),
    );
    const awaiting = write(
      `users/${BOB}/workflow/awaiting.workflow.json`,
      fixture("awaiting-no-schema.workflow.json"),
    );
    const url = await start({ hosted: true });

    const failed = (await (await launch(url, BOB, failing)).json()) as { root_run_id: string };
    await waitFor(url, BOB, failed.root_run_id, (tree) => tree.status !== "running");
    const resumed = await fetch(
      `${url}/v0/runs/${failed.root_run_id}/resume`,
      as(ALICE, "POST", {}),
    );
    expect(resumed.status).toBe(404);
    expect(await resumed.json()).toEqual({
      error: { message: `no run found with id "${failed.root_run_id}"` },
    });

    const parked = (await (await launch(url, BOB, awaiting)).json()) as { root_run_id: string };
    const tree = await waitFor(url, BOB, parked.root_run_id, (t) =>
      t.runs.some((r) => r.status === "awaiting"),
    );
    const leaf = tree.runs.find((r) => r.status === "awaiting");
    const completed = await fetch(
      `${url}/v0/runs/${leaf?.run_id}/complete`,
      as(ALICE, "POST", { output: "done" }),
    );
    expect(completed.status).toBe(404);
    expect(await completed.json()).toEqual({
      error: { message: `no step run found with id "${leaf?.run_id}"` },
    });
  });

  it("fails a launch whose ref leaves the launcher's view, naming the ref", async () => {
    const ref = `../../${BOB}/workflow/child.workflow.json`;
    write(`users/${BOB}/workflow/child.workflow.json`, workflow("child"));
    const parent = write(
      `users/${ALICE}/workflow/parent.workflow.json`,
      workflow("parent", [refStep(ref)]),
    );
    const url = await start({ hosted: true });

    const res = await launch(url, ALICE, parent);

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { details: string[] } };
    expect(error.details.join("\n")).toContain(`ref "${ref}"`);
  });

  it("refuses a ref through a symlink that leads out of the view", async () => {
    write(`users/${BOB}/workflow/child.workflow.json`, workflow("child"));
    const parent = write(
      `users/${ALICE}/workflow/parent.workflow.json`,
      workflow("parent", [refStep("./child.workflow.json")]),
    );
    symlinkSync(
      join(projectDir, "users", BOB, "workflow", "child.workflow.json"),
      join(projectDir, "users", ALICE, "workflow", "child.workflow.json"),
    );
    const url = await start({ hosted: true });

    const res = await launch(url, ALICE, parent);

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { details: string[] } };
    expect(error.details.join("\n")).toContain('ref "./child.workflow.json"');
  });

  it("checks a shared workflow's refs against the launcher's view, not the creator's", async () => {
    const ref = `../../users/${BOB}/workflow/child.workflow.json`;
    write(`users/${BOB}/workflow/child.workflow.json`, workflow("child"));
    const shared = write("shared/workflow/team.workflow.json", workflow("team", [refStep(ref)]));
    const url = await start({ hosted: true });

    expect((await launch(url, BOB, shared)).status).toBe(202);
    expect((await launch(url, ALICE, shared)).status).toBe(400);
  });
});

describe("local mode", () => {
  it("keeps following refs and paths anywhere in the project", async () => {
    write("examples/child.workflow.json", workflow("child"));
    const parent = write(
      "users/local/workflow/parent.workflow.json",
      workflow("parent", [refStep("../../../examples/child.workflow.json")]),
    );
    const other = write(`users/${BOB}/workflow/bob.workflow.json`, workflow("bob"));
    const url = await start({ hosted: false });

    expect(
      (await fetch(`${url}/v0/runs`, as("local", "POST", { workflow_path: parent }))).status,
    ).toBe(202);
    expect((await fetch(`${url}/v0/workflows/file?path=${other}`)).status).toBe(200);
  });
});

/** The root run ids the store opened at `dir` lists. */
function storedRoots(dir: string): string[] {
  const opened = openProject(dir);
  if (!opened.success) throw new Error(opened.error);
  try {
    return opened.project.archive.listRoots().map((row) => row.runId);
  } finally {
    opened.project.close();
  }
}

describe("per-user run stores in hosted mode", () => {
  async function launched(url: string, userId: string, workflowPath: string): Promise<string> {
    const res = await launch(url, userId, workflowPath);
    expect(res.status).toBe(202);
    return ((await res.json()) as { root_run_id: string }).root_run_id;
  }

  it("stores a run under its launcher's store, not the project's", async () => {
    const team = write("shared/workflow/team.workflow.json", workflow("team"));
    const url = await start({ hosted: true });

    const rootRunId = await launched(url, ALICE, team);
    await waitFor(url, ALICE, rootRunId, (tree) => tree.status === "succeeded");
    await handle?.close();
    handle = undefined;

    expect(storedRoots(join(projectDir, "users", ALICE))).toEqual([rootRunId]);
    expect(storedRoots(projectDir)).toEqual([]);
  });

  it("answers 404 on every run door for another user's run", async () => {
    const failing = write(
      `users/${ALICE}/workflow/failing.workflow.json`,
      fixture("failing-step.workflow.json"),
    );
    const awaiting = write(
      `users/${ALICE}/workflow/awaiting.workflow.json`,
      fixture("awaiting-no-schema.workflow.json"),
    );
    const url = await start({ hosted: true });
    const failed = await launched(url, ALICE, failing);
    await waitFor(url, ALICE, failed, (tree) => tree.status !== "running");
    const parked = await launched(url, ALICE, awaiting);
    const tree = await waitFor(url, ALICE, parked, (t) =>
      t.runs.some((r) => r.status === "awaiting"),
    );
    const leaf = tree.runs.find((r) => r.status === "awaiting")?.run_id;

    const replies = await Promise.all([
      fetch(`${url}/v0/runs/${failed}`, as(BOB)),
      fetch(`${url}/v0/runs/${failed}/events`, as(BOB)),
      fetch(`${url}/v0/runs/${failed}/blobs/${failed}/input`, as(BOB)),
      fetch(`${url}/v0/runs/${parked}/cancel`, as(BOB, "POST", {})),
      fetch(`${url}/v0/runs/${failed}/resume`, as(BOB, "POST", {})),
      fetch(`${url}/v0/runs/${leaf}/complete`, as(BOB, "POST", { output: "done" })),
      fetch(`${url}/v0/runs/${failed}`, as(BOB, "DELETE")),
    ]);

    expect(replies.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect((await fetch(`${url}/v0/runs/${failed}`, as(ALICE))).status).toBe(200);
    // Releases the parked run so the server drains on close.
    await fetch(`${url}/v0/runs/${parked}/cancel`, as(ALICE, "POST", {}));
  });

  it("resumes the requester's own run from their store", async () => {
    const failing = write(
      `users/${ALICE}/workflow/failing.workflow.json`,
      fixture("failing-step.workflow.json"),
    );
    const url = await start({ hosted: true });
    const failed = await launched(url, ALICE, failing);
    await waitFor(url, ALICE, failed, (tree) => tree.status !== "running");

    const resumed = await fetch(`${url}/v0/runs/${failed}/resume`, as(ALICE, "POST", {}));

    expect(resumed.status).toBe(202);
    const successor = ((await resumed.json()) as { root_run_id: string }).root_run_id;
    await waitFor(url, ALICE, successor, (tree) => tree.status !== "running");
  });

  it("keeps workflow doors on the project root, not the requester's store", async () => {
    const own = write(`users/${ALICE}/workflow/mine.workflow.json`, workflow("mine"));
    const url = await start({ hosted: true });
    const lock = { workflow_path: own, session_id: "s1" };

    expect((await fetch(`${url}/v0/workflows/file?path=${own}`, as(ALICE))).status).toBe(200);
    expect((await fetch(`${url}/v0/workflows/lock`, as(ALICE, "POST", lock))).status).toBe(200);
  });

  it("lists only the requester's own runs of a shared workflow", async () => {
    const team = workflow("team");
    const path = write("shared/workflow/team.workflow.json", team);
    const url = await start({ hosted: true });

    const alices = await launched(url, ALICE, path);
    const bobs = await launched(url, BOB, path);
    await waitFor(url, ALICE, alices, (tree) => tree.status === "succeeded");
    await waitFor(url, BOB, bobs, (tree) => tree.status === "succeeded");

    for (const [user, own] of [
      [ALICE, alices],
      [BOB, bobs],
    ] as const) {
      const res = await fetch(`${url}/v0/runs?workflow_id=${team.id}`, as(user));
      const { runs } = (await res.json()) as { runs: { run_id: string }[] };
      expect(runs.map((r) => r.run_id)).toEqual([own]);
    }
  });

  it("never serves a run from the project's own store", async () => {
    const path = write("shared/workflow/team.workflow.json", workflow("team"));
    const localUrl = await start({ hosted: false });
    const local = (await (
      await fetch(`${localUrl}/v0/runs`, as("local", "POST", { workflow_path: path }))
    ).json()) as { root_run_id: string };
    await waitFor(localUrl, "local", local.root_run_id, (tree) => tree.status === "succeeded");
    await handle?.close();

    const url = await start({ hosted: true });

    expect((await fetch(`${url}/v0/runs/${local.root_run_id}`, as(ALICE))).status).toBe(404);
    const listed = (await (await fetch(`${url}/v0/runs`, as(ALICE))).json()) as {
      runs: unknown[];
    };
    expect(listed.runs).toEqual([]);
  });
});

describe("local mode runs", () => {
  it("keeps every run in the project's own store", async () => {
    const path = write("users/local/workflow/mine.workflow.json", workflow("mine"));
    const url = await start({ hosted: false });

    const res = await fetch(`${url}/v0/runs`, as("local", "POST", { workflow_path: path }));
    const { root_run_id: rootRunId } = (await res.json()) as { root_run_id: string };
    await waitFor(url, "local", rootRunId, (tree) => tree.status === "succeeded");
    await handle?.close();
    handle = undefined;

    expect(storedRoots(projectDir)).toEqual([rootRunId]);
  });
});
