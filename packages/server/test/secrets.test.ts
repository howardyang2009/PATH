import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PathServerHandle, startPathServer } from "../src/create-server.js";
import { clerkToken, hostedMode, stubHostedEnv } from "./fixtures/clerk-token.js";

/**
 * The Secret store doors and the runs that read them (ADR 0089): set, list and delete never return
 * a value; local mode answers `404`; a hosted run resolves `$env` against its launcher's store only,
 * masks every stored value, and a Resume or Complete reads the store again.
 */

const ALICE = "user_alice";
const BOB = "user_bob";
const VALUE = "sk-alice-0123456789abcdef";

let projectDir: string;
let shippedDir: string;
let handle: PathServerHandle | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-secrets-project-"));
  shippedDir = mkdtempSync(join(tmpdir(), "path-secrets-shipped-"));
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
    hosted ? hostedMode(projectDir) : undefined,
  );
  return handle.url;
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

function putSecret(url: string, userId: string, name: string, value: unknown): Promise<Response> {
  return fetch(`${url}/v0/secrets/${name}`, as(userId, "PUT", { value }));
}

/** Writes a workflow at `relPath` whose step echoes `config.token` (sourced from `$env` `name`),
 * reversed when `reverse`, so a test can tell which value it got without the masker scrubbing it.
 * `parkFirst` puts a person activity before the echo, so the echo runs on Complete. */
function echoWorkflow(
  relPath: string,
  name: string,
  { reverse = false, parkFirst = false } = {},
): string {
  const script = reverse
    ? "process.stdout.write(process.argv[1].split('').reverse().join(''))"
    : "process.stdout.write(process.argv[1])";
  const file = {
    format: "path/workflow@6",
    id: randomUUID(),
    name: "echo-secret",
    config: { token: { $env: name } },
    body: [
      ...(parkFirst
        ? [{ type: "person-activity", id: randomUUID(), name: "collect", description: "x" }]
        : []),
      {
        type: "binary",
        id: randomUUID(),
        name: "echo",
        command: "node",
        args: ["-e", script, "${config.token}"],
        publish: { seen: "${output}" },
      },
    ],
    output: { seen: "${context.seen}" },
  };
  const abs = join(projectDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(file));
  return relPath;
}

interface RunTree {
  status: string;
  runs: { run_id: string; status: string }[];
}

async function launched(url: string, userId: string, workflowPath: string): Promise<string> {
  const res = await fetch(`${url}/v0/runs`, as(userId, "POST", { workflow_path: workflowPath }));
  expect(res.status).toBe(202);
  return ((await res.json()) as { root_run_id: string }).root_run_id;
}

/** Polls the run tree until `done` holds; by default, until the root run is terminal. */
async function settled(
  url: string,
  userId: string,
  rootRunId: string,
  done = (tree: RunTree) => !["pending", "running", "awaiting"].includes(tree.status),
): Promise<RunTree> {
  for (let i = 0; i < 200; i++) {
    const tree = (await (await fetch(`${url}/v0/runs/${rootRunId}`, as(userId))).json()) as RunTree;
    if (done(tree)) return tree;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${rootRunId} never settled`);
}

async function rootOutput(url: string, userId: string, rootRunId: string): Promise<unknown> {
  const res = await fetch(`${url}/v0/runs/${rootRunId}/blobs/${rootRunId}/output`, as(userId));
  return res.json();
}

/** Every file under a user's `.path/`, read as text: what a run left on disk. */
function storedText(userId: string): string {
  const root = join(projectDir, "users", userId, ".path");
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("the Secret store doors", () => {
  it("answers 404 on every door in local mode", async () => {
    const url = await start({ hosted: false });
    const replies = await Promise.all([
      fetch(`${url}/v0/secrets`),
      fetch(`${url}/v0/secrets/TOKEN`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: VALUE }),
      }),
      fetch(`${url}/v0/secrets/TOKEN`, { method: "DELETE" }),
    ]);
    expect(replies.map((r) => r.status)).toEqual([404, 404, 404]);
  });

  it("refuses to start hosted mode without the master key", async () => {
    stubHostedEnv();
    vi.stubEnv("PATH_SECRETS_KEY", undefined);
    await expect(startPathServer(projectDir)).rejects.toThrow(/PATH_SECRETS_KEY/);
  });

  it("sets, lists and deletes without ever returning a value", async () => {
    const url = await start({ hosted: true });

    const put = await putSecret(url, ALICE, "API_TOKEN", VALUE);
    expect(put.status).toBe(200);
    const putBody = await put.text();
    expect(putBody).not.toContain(VALUE);
    expect(JSON.parse(putBody)).toEqual({ name: "API_TOKEN", updated_at: expect.any(String) });

    const list = await fetch(`${url}/v0/secrets`, as(ALICE));
    const listBody = await list.text();
    expect(list.status).toBe(200);
    expect(listBody).not.toContain(VALUE);
    expect(JSON.parse(listBody)).toEqual({
      secrets: [{ name: "API_TOKEN", updated_at: expect.any(String) }],
    });

    expect((await fetch(`${url}/v0/secrets/API_TOKEN`, as(ALICE, "DELETE"))).status).toBe(204);
    expect((await fetch(`${url}/v0/secrets/API_TOKEN`, as(ALICE, "DELETE"))).status).toBe(404);
    expect(await (await fetch(`${url}/v0/secrets`, as(ALICE))).json()).toEqual({ secrets: [] });
  });

  it("keeps each user's secrets apart", async () => {
    const url = await start({ hosted: true });
    await putSecret(url, ALICE, "API_TOKEN", VALUE);

    expect(await (await fetch(`${url}/v0/secrets`, as(BOB))).json()).toEqual({ secrets: [] });
    expect((await fetch(`${url}/v0/secrets/API_TOKEN`, as(BOB, "DELETE"))).status).toBe(404);
  });

  it("stores the value encrypted in the user's own path.db", async () => {
    const url = await start({ hosted: true });
    await putSecret(url, ALICE, "API_TOKEN", VALUE);
    await handle?.close();
    handle = undefined;

    expect(storedText(ALICE)).not.toContain(VALUE);
  });

  it.each([
    ["a malformed name", "api-token", VALUE],
    ["a reserved name", "PATH_SECRETS_KEY", VALUE],
    ["a value over 64 KiB", "BIG", "x".repeat(64 * 1024 + 1)],
    ["a value that is not a string", "API_TOKEN", 42],
  ])("answers 400 to %s", async (_why, name, value) => {
    const url = await start({ hosted: true });
    expect((await putSecret(url, ALICE, name, value)).status).toBe(400);
  });

  it("answers 400 to a DELETE of a reserved name", async () => {
    const url = await start({ hosted: true });
    expect((await fetch(`${url}/v0/secrets/PATH`, as(ALICE, "DELETE"))).status).toBe(400);
  });

  it("answers 400 past 100 secrets", async () => {
    const url = await start({ hosted: true });
    for (let i = 0; i < 100; i += 1) {
      expect((await putSecret(url, ALICE, `KEY_${i}`, `value-${i}`)).status).toBe(200);
    }
    const refused = await putSecret(url, ALICE, "ONE_MORE", VALUE);
    expect(refused.status).toBe(400);
  });
});

describe("a hosted run against the launcher's Secret store", () => {
  it("resolves $env from the store and masks the value on disk", async () => {
    const wf = echoWorkflow(`users/${ALICE}/workflow/echo.workflow.json`, "API_TOKEN");
    const url = await start({ hosted: true });
    await putSecret(url, ALICE, "API_TOKEN", VALUE);

    const rootRunId = await launched(url, ALICE, wf);
    expect((await settled(url, ALICE, rootRunId)).status).toBe("succeeded");
    expect(await rootOutput(url, ALICE, rootRunId)).toEqual({ seen: "[secret:API_TOKEN]" });
    await handle?.close();
    handle = undefined;

    const onDisk = storedText(ALICE);
    expect(onDisk).not.toContain(VALUE);
    expect(onDisk).toContain("[secret:API_TOKEN]");
  });

  it("never reads the host environment, failing before the first step", async () => {
    const wf = echoWorkflow(`users/${ALICE}/workflow/echo.workflow.json`, "HOST_ONLY_TOKEN");
    vi.stubEnv("HOST_ONLY_TOKEN", "the-owner's-own-value");
    const url = await start({ hosted: true });

    const rootRunId = await launched(url, ALICE, wf);
    const tree = await settled(url, ALICE, rootRunId);
    expect(tree.status).toBe("failed");
    expect(tree.runs.every((r) => r.run_id === rootRunId)).toBe(true);
  });

  it("uses the launcher's store for a shared workflow, not the creator's", async () => {
    const wf = echoWorkflow("shared/workflow/echo.workflow.json", "API_TOKEN", { reverse: true });
    const url = await start({ hosted: true });
    await putSecret(url, ALICE, "API_TOKEN", VALUE);
    await putSecret(url, BOB, "API_TOKEN", "sk-bob-fedcba9876543210");

    const rootRunId = await launched(url, BOB, wf);
    expect((await settled(url, BOB, rootRunId)).status).toBe("succeeded");
    expect(await rootOutput(url, BOB, rootRunId)).toEqual({ seen: "0123456789abcdef-bob-ks" });
  });

  it("resolves again on Resume, reading the store as it is then", async () => {
    const wf = echoWorkflow(`users/${ALICE}/workflow/echo.workflow.json`, "API_TOKEN", {
      reverse: true,
    });
    const url = await start({ hosted: true });

    const failed = await launched(url, ALICE, wf);
    expect((await settled(url, ALICE, failed)).status).toBe("failed");

    await putSecret(url, ALICE, "API_TOKEN", VALUE);
    const resumed = await fetch(`${url}/v0/runs/${failed}/resume`, as(ALICE, "POST", {}));
    expect(resumed.status).toBe(202);
    const successor = ((await resumed.json()) as { root_run_id: string }).root_run_id;
    expect((await settled(url, ALICE, successor)).status).toBe("succeeded");
    expect(await rootOutput(url, ALICE, successor)).toEqual({
      seen: [...VALUE].reverse().join(""),
    });
  });

  it("resolves again on Complete, reading a rotated value", async () => {
    const wf = echoWorkflow(`users/${ALICE}/workflow/park.workflow.json`, "API_TOKEN", {
      reverse: true,
      parkFirst: true,
    });
    const url = await start({ hosted: true });
    await putSecret(url, ALICE, "API_TOKEN", VALUE);

    const rootRunId = await launched(url, ALICE, wf);
    const parked = await settled(url, ALICE, rootRunId, (t) =>
      t.runs.some((r) => r.status === "awaiting"),
    );
    const leaf = parked.runs.find((r) => r.status === "awaiting")?.run_id;

    const rotated = "sk-alice-rotated-99887766";
    await putSecret(url, ALICE, "API_TOKEN", rotated);
    const completed = await fetch(
      `${url}/v0/runs/${leaf}/complete`,
      as(ALICE, "POST", { output: "done" }),
    );
    expect(completed.status).toBe(202);
    expect((await settled(url, ALICE, rootRunId)).status).toBe("succeeded");
    expect(await rootOutput(url, ALICE, rootRunId)).toEqual({
      seen: [...rotated].reverse().join(""),
    });
  });
});
