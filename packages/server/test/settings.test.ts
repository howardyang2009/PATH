import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathDir, rootRunTreeDir } from "@path/engine";
import { afterEach, describe, expect, it } from "vitest";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * `.path/settings.json` (mvp spec §9) is the operator's per-checkout engine configuration. It was
 * read by `path run` and ignored entirely by `path-server`, even though server-api-v0.md §4.1
 * describes the request fields as "Same as `path run --log-backends`". Since #64 both go through
 * `Project`, which owns one precedence rule: request field > settings file > built-in default.
 */

let projectDir: string;
let handle: PathServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

async function startWithSettings(settings: unknown | undefined): Promise<void> {
  projectDir = mkdtempSync(join(tmpdir(), "path-server-settings-test-"));
  cpSync(fixturesDir, projectDir, { recursive: true });
  if (settings !== undefined) {
    mkdirSync(pathDir(projectDir), { recursive: true });
    writeFileSync(join(pathDir(projectDir), "settings.json"), JSON.stringify(settings), "utf8");
  }
  handle = await startPathServer(projectDir);
}

async function runAndWait(body: unknown): Promise<string> {
  const res = await fetch(`${handle!.url}/v0/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  const { root_run_id: rootRunId } = (await res.json()) as { root_run_id: string };

  for (let i = 0; i < 100; i += 1) {
    const tree = await fetch(`${handle!.url}/v0/runs/${rootRunId}`);
    const { status } = (await tree.json()) as { status: string };
    if (status !== "running" && status !== "pending") return rootRunId;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run did not settle");
}

function hasRunLog(rootRunId: string): boolean {
  return existsSync(join(rootRunTreeDir(projectDir, rootRunId), "run.log"));
}

describe("POST /v0/runs — engine settings", () => {
  it("writes run.log by default, with no settings file", async () => {
    await startWithSettings(undefined);
    const rootRunId = await runAndWait({ workflow_path: "two-binary-steps.workflow.json" });
    expect(hasRunLog(rootRunId)).toBe(true);
  });

  // The behaviour that changed in #64: before, this file was read by the CLI and ignored here.
  it("honours .path/settings.json when the request names no backends", async () => {
    await startWithSettings({ "log.backends": ["db"] });
    const rootRunId = await runAndWait({ workflow_path: "two-binary-steps.workflow.json" });
    expect(hasRunLog(rootRunId)).toBe(false);
  });

  it("lets the request field beat the settings file", async () => {
    await startWithSettings({ "log.backends": ["db"] });
    const rootRunId = await runAndWait({ workflow_path: "two-binary-steps.workflow.json", log_backends: ["db", "ndjson"] });
    expect(hasRunLog(rootRunId)).toBe(true);
  });

  it("refuses to boot on a malformed settings file rather than silently ignoring it", async () => {
    projectDir = mkdtempSync(join(tmpdir(), "path-server-settings-test-"));
    cpSync(fixturesDir, projectDir, { recursive: true });
    mkdirSync(pathDir(projectDir), { recursive: true });
    writeFileSync(join(pathDir(projectDir), "settings.json"), JSON.stringify({ "log.backends": ["nope"] }), "utf8");

    await expect(startPathServer(projectDir)).rejects.toThrow(/invalid engine-settings file/);
  });
});
