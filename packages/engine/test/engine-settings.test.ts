import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEngineSettings } from "../src/settings/engine-settings.js";

// The engine-settings file is the durable home for the two engine-level operator settings
// (ticket #27, mvp spec §9): `log.backends` and the LLM processor cap. It lives inside the
// project's `.path/`, beside `path.db`.
let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-engine-settings-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writeSettings(contents: string): void {
  mkdirSync(join(projectDir, ".path"), { recursive: true });
  writeFileSync(join(projectDir, ".path", "settings.json"), contents, "utf8");
}

describe("loadEngineSettings", () => {
  it("returns no settings when the project has no engine-settings file", () => {
    const result = loadEngineSettings(projectDir);
    expect(result).toEqual({ success: true, settings: {} });
  });

  it("reads log.backends and llm.concurrency from the file", () => {
    writeSettings(JSON.stringify({ "log.backends": ["ndjson"], "llm.concurrency": 7 }));

    const result = loadEngineSettings(projectDir);
    expect(result).toEqual({ success: true, settings: { logBackends: ["ndjson"], llmConcurrency: 7 } });
  });

  it("reads an empty log.backends list as 'no backends', not as an absent setting", () => {
    writeSettings(JSON.stringify({ "log.backends": [] }));

    const result = loadEngineSettings(projectDir);
    expect(result).toEqual({ success: true, settings: { logBackends: [] } });
  });

  it("rejects a malformed file, naming the file and the reason", () => {
    writeSettings("{ not json");

    const result = loadEngineSettings(projectDir);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(/\.path[/\\]settings\.json/);
  });

  it("rejects an unknown key rather than silently ignoring it", () => {
    writeSettings(JSON.stringify({ "log.backend": ["db"] }));

    const result = loadEngineSettings(projectDir);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(/log\.backend/);
  });

  it("rejects an unknown log backend id, listing the ids it accepts", () => {
    writeSettings(JSON.stringify({ "log.backends": ["syslog"] }));

    const result = loadEngineSettings(projectDir);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(/log\.backends/);
  });

  it("rejects a non-positive-integer cap", () => {
    writeSettings(JSON.stringify({ "llm.concurrency": 0 }));

    const result = loadEngineSettings(projectDir);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(/llm\.concurrency/);
  });

  it("rejects a file that is not a JSON object", () => {
    writeSettings(JSON.stringify(["db"]));

    const result = loadEngineSettings(projectDir);
    expect(result.success).toBe(false);
  });
});
