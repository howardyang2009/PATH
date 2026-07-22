import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(packageRoot, "test", "fixtures");
const bin = join(packageRoot, "bin", "path-server.ts");

let projectDir: string;
let child: ChildProcessWithoutNullStreams | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-server-bin-e2e-"));
  cpSync(fixturesDir, projectDir, { recursive: true });
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  rmSync(projectDir, { recursive: true, force: true });
});

/** Spawns the real `path-server` bin (dev-mode, via tsx) and resolves once it prints its URL. */
function startBin(args: string[]): Promise<{ url: string; process: ChildProcessWithoutNullStreams }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("npx", ["tsx", bin, ...args], { cwd: packageRoot });
    child = proc;
    let stdout = "";
    let stderr = "";
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /Listening on (http:\/\/localhost:\d+)/.exec(stdout);
      if (match) {
        proc.stdout.off("data", onData);
        resolvePromise({ url: match[1]!, process: proc });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once("exit", (code) => reject(new Error(`path-server exited (code ${code}) before printing its URL: ${stderr}`)));
    proc.once("error", reject);
  });
}

describe("path-server bin (real dev-mode process, no packaging)", () => {
  it("starts against a project directory, binds an ephemeral port, and prints the URL", async () => {
    const { url } = await startBin([projectDir, "--port", "0"]);
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);

    const res = await fetch(`${url}/v0/runs/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  it("project-dir defaults to cwd when omitted", async () => {
    child = spawn("npx", ["tsx", bin, "--port", "0"], { cwd: projectDir });
    let stdout = "";
    const url = await new Promise<string>((resolvePromise, reject) => {
      child!.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = /Listening on (http:\/\/localhost:\d+)/.exec(stdout);
        if (match) resolvePromise(match[1]!);
      });
      child!.once("exit", (code) => reject(new Error(`exited (code ${code}) before printing its URL`)));
      child!.once("error", reject);
    });

    const postRes = await fetch(`${url}/v0/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_path: "two-binary-steps.workflow.json" }),
    });
    expect(postRes.status).toBe(202);
  });
});
