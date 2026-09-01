import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedStepPluginRegistry } from "@path/engine";
import type { StepPluginsResponse } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startPathServer, type PathServerHandle } from "../src/create-server.js";

let projectDir: string;
let handle: PathServerHandle;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-step-plugins-test-"));
});

afterEach(async () => {
  if (handle) await handle.close();
  rmSync(projectDir, { recursive: true, force: true });
});

/** `GET /v0/step-plugins` against a server started over `stepPlugins` (defaults to the real scan). */
async function getStepPlugins(stepPlugins?: LoadedStepPluginRegistry): Promise<Response> {
  handle = await startPathServer(projectDir, 0, undefined, undefined, stepPlugins);
  return fetch(`${handle.url}/v0/step-plugins`);
}

const doNotRun = () => Promise.reject(new Error("run must not be called"));

describe("GET /v0/step-plugins", () => {
  it("serves the real registry: `prompt` and `binary` appear as ordinary snake_case entries", async () => {
    // No injection — the server scans the real `packages/engine/step-plugins/` folder at start.
    const res = await getStepPlugins();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = (await res.json()) as StepPluginsResponse;
    const byName = Object.fromEntries(body.step_plugins.map((p) => [p.name, p]));

    // Both built-ins are present, peers of any plugin type (ADR 0021).
    expect(Object.keys(byName)).toEqual(expect.arrayContaining(["binary", "prompt"]));

    // Each entry matches its registration, snake_case on the wire.
    expect(byName.prompt).toEqual({
      name: "prompt",
      fields: { prompt: { type: "string", optional: false } },
      workers: ["sdk"],
      default_worker: "sdk",
    });
    expect(byName.binary).toEqual({
      name: "binary",
      fields: {
        command: { type: "string", optional: false },
        args: { type: "array", optional: true, element: { type: "string", optional: false } },
        cwd: { type: "string", optional: true },
      },
      workers: ["spawn"],
      default_worker: "spawn",
    });
  });

  it("serves every worker name of a >1-worker type, with its declared default", async () => {
    const registry: LoadedStepPluginRegistry = {
      "api-call": {
        fields: { endpoint: z.string(), method: z.string().optional() },
        config: {},
        workers: {
          fetch: { run: doNotRun, meters: false, needsProcessorSlot: false },
          sdk: { run: doNotRun, meters: true, needsProcessorSlot: true },
        },
        defaultWorker: "fetch",
      },
    };

    const res = await getStepPlugins(registry);
    expect(res.status).toBe(200);

    const body = (await res.json()) as StepPluginsResponse;
    expect(body.step_plugins).toEqual([
      {
        name: "api-call",
        fields: {
          endpoint: { type: "string", optional: false },
          method: { type: "string", optional: true },
        },
        workers: ["fetch", "sdk"],
        default_worker: "fetch",
      },
    ]);
  });

  it("is an ungated read: no origin gate on GET (server-api-v0.md §2.1)", async () => {
    // A cross-origin `Origin` header would fail the §2.1 gate on a mutating route; a GET passes.
    handle = await startPathServer(projectDir);
    const res = await fetch(`${handle.url}/v0/step-plugins`, {
      headers: { Origin: "http://evil.example" },
    });
    expect(res.status).toBe(200);
  });
});
