import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { LlmWorker } from "../src/llm/llm-worker.js";

const realFixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// `path run` now writes a real .path/ (db + blobs) beside the workflow file (ticket #18) — run
// against a throwaway copy of the fixtures so tests never leave state in the checked-in tree.
let fixtures: string;

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "path-engine-cli-test-"));
  cpSync(realFixtures, fixtures, { recursive: true });
});

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

function fakeIo() {
  return { log: vi.fn(), error: vi.fn() };
}

describe("cli main()", () => {
  it("runs a valid workflow and prints its final output", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "two-binary-steps.workflow.json")], io);
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ shouted: "HELLO" }));
    expect(io.error).not.toHaveBeenCalled();
  });

  it("exits non-zero and reports load-time errors without running anything", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "invalid-schema.workflow.json")], io);
    expect(code).toBe(1);
    expect(io.error.mock.calls.join("\n")).toMatch(/bogus_field/);
    expect(io.log).not.toHaveBeenCalled();
  });

  it("exits non-zero and reports a ref cycle before running anything", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "cycle-a.workflow.json")], io);
    expect(code).toBe(1);
    expect(io.error.mock.calls.join("\n")).toMatch(/cycle/i);
  });

  it("exits non-zero when a step fails", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "failing-step.workflow.json")], io);
    expect(code).toBe(1);
    expect(io.error.mock.calls.join("\n")).toMatch(/run failed/);
  });

  it("prints usage and exits non-zero for a missing workflow path", async () => {
    const io = fakeIo();
    const code = await main(["run"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/usage/i));
  });
});

describe("cli main() — operator config flags (ticket #17)", () => {
  function configEcho() {
    return join(fixtures, "config-echo.workflow.json");
  }

  it("uses the file's config default with no flags", async () => {
    const io = fakeIo();
    const code = await main(["run", configEcho()], io);
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "file-default" }));
  });

  it("--set overrides the file default, nearest wins", async () => {
    const io = fakeIo();
    const code = await main(["run", configEcho(), "--set", "greeting=operator-value"], io);
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "operator-value" }));
  });

  it("--config loads a whole object that overrides the file default", async () => {
    const io = fakeIo();
    const code = await main(["run", configEcho(), "--config", join(fixtures, "config-override.json")], io);
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "config-file-value" }));
  });

  it("--set wins over --config when both touch the same key", async () => {
    const io = fakeIo();
    const code = await main(
      ["run", configEcho(), "--config", join(fixtures, "config-override.json"), "--set", "greeting=set-value"],
      io,
    );
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "set-value" }));
  });

  it("reports a clear error for a malformed --set argument", async () => {
    const io = fakeIo();
    const code = await main(["run", configEcho(), "--set", "no-equals-sign"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--set/));
  });

  it("reports a clear error when --config points at a missing file", async () => {
    const io = fakeIo();
    const code = await main(["run", configEcho(), "--config", join(fixtures, "nope.json")], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--config/));
  });
});

describe("cli main() — log.backends setting (ticket #19)", () => {
  it("accepts --log-backends to select the audit stream and still runs the workflow", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "two-binary-steps.workflow.json"), "--log-backends", "ndjson"], io);
    expect(code).toBe(0);
    expect(io.error).not.toHaveBeenCalled();
  });

  it("reports a clear error for an unknown backend id", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "two-binary-steps.workflow.json"), "--log-backends", "syslog"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/syslog/));
  });
});

// The engine-settings file (ticket #27) carries the same two engine-level settings the flags do,
// so an operator sets them once per project. Nearest wins: flag > file > built-in default.
describe("cli main() — engine-settings file (ticket #27)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-engine-settings-cli-"));
    cpSync(join(realFixtures, "two-binary-steps.workflow.json"), join(projectDir, "workflow.json"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeSettings(settings: unknown): void {
    mkdirSync(join(projectDir, ".path"), { recursive: true });
    writeFileSync(join(projectDir, ".path", "settings.json"), JSON.stringify(settings), "utf8");
  }

  // `run.log` is the NDJSON backend's only artifact, so its presence is the observable proof of
  // which backends the run actually fanned out to.
  function ndjsonLogWritten(): boolean {
    const runsDir = join(projectDir, ".path", "runs");
    if (!existsSync(runsDir)) return false;
    return readdirSync(runsDir).some((rootRunId) => existsSync(join(runsDir, rootRunId, "run.log")));
  }

  function runWorkflowFile(...args: string[]) {
    return main(["run", join(projectDir, "workflow.json"), ...args], fakeIo());
  }

  it("applies the file's log.backends with no CLI flags", async () => {
    writeSettings({ "log.backends": ["db"] });

    expect(await runWorkflowFile()).toBe(0);
    expect(ndjsonLogWritten()).toBe(false); // db only — the ndjson backend never opened
  });

  it("lets --log-backends override the file for that run", async () => {
    writeSettings({ "log.backends": ["db"] });

    expect(await runWorkflowFile("--log-backends", "ndjson")).toBe(0);
    expect(ndjsonLogWritten()).toBe(true);
  });

  it("falls back to the built-in default (both backends on) with no file", async () => {
    expect(await runWorkflowFile()).toBe(0);
    expect(ndjsonLogWritten()).toBe(true);
  });

  // The separation that matters (CONTEXT.md: Config is read *by steps*, engine settings by the
  // *engine*). A step asking for `${config.llm.concurrency}` must find nothing there even when the
  // settings file sets it: the plausible regression is an implementer merging the settings into
  // operator Config under nested keys, which would make this run succeed and print the cap.
  it("never leaks an engine setting into a step's Config", async () => {
    writeSettings({ "llm.concurrency": 2 });
    cpSync(join(realFixtures, "config-leak-probe.workflow.json"), join(projectDir, "probe.workflow.json"));

    const io = fakeIo();
    const code = await main(["run", join(projectDir, "probe.workflow.json")], io);
    expect(code).toBe(1);
    expect(io.error.mock.calls.join("\n")).toMatch(/cannot resolve "config\.llm\.concurrency"/);
    expect(io.log).not.toHaveBeenCalled();
  });

  it("refuses to run on a malformed settings file, naming it", async () => {
    mkdirSync(join(projectDir, ".path"), { recursive: true });
    writeFileSync(join(projectDir, ".path", "settings.json"), "{ not json", "utf8");

    const io = fakeIo();
    const code = await main(["run", join(projectDir, "workflow.json")], io);
    expect(code).toBe(2);
    expect(io.error.mock.calls.join("\n")).toMatch(/settings\.json/);
    expect(io.log).not.toHaveBeenCalled();
  });

  // A scripted worker in place of a live Agent SDK processor: the same seam the acceptance run
  // uses. `peakLive` is the observable proof of the cap the engine actually applied.
  function countingLlmWorker() {
    let live = 0;
    let peakLive = 0;
    const worker: LlmWorker = {
      async runPrompt() {
        live += 1;
        peakLive = Math.max(peakLive, live);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { status: "succeeded", output: "ok", usage: null, estimatedCostUsd: null };
        } finally {
          live -= 1;
        }
      },
    };
    return {
      worker,
      get peakLive() {
        return peakLive;
      },
    };
  }

  function runFanout(llmWorker: LlmWorker, ...args: string[]) {
    cpSync(join(realFixtures, "llm-fanout.workflow.json"), join(projectDir, "fanout.workflow.json"));
    return main(["run", join(projectDir, "fanout.workflow.json"), ...args], fakeIo(), { llmWorker });
  }

  it("applies the file's llm.concurrency cap with no CLI flags", async () => {
    writeSettings({ "llm.concurrency": 2 });
    const llm = countingLlmWorker();

    expect(await runFanout(llm.worker)).toBe(0);
    expect(llm.peakLive).toBe(2);
  });

  it("lets --llm-concurrency override the file's cap for that run", async () => {
    writeSettings({ "llm.concurrency": 2 });
    const llm = countingLlmWorker();

    expect(await runFanout(llm.worker, "--llm-concurrency", "1")).toBe(0);
    expect(llm.peakLive).toBe(1);
  });

  it("refuses to run on an unknown settings key", async () => {
    writeSettings({ "llm.concurrancy": 2 });

    const io = fakeIo();
    const code = await main(["run", join(projectDir, "workflow.json")], io);
    expect(code).toBe(2);
    expect(io.error.mock.calls.join("\n")).toMatch(/llm\.concurrancy/);
  });
});

describe("cli main() — LLM processor cap (ticket #25)", () => {
  it("accepts --llm-concurrency to override the engine-wide cap and still runs the workflow", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "two-binary-steps.workflow.json"), "--llm-concurrency", "2"], io);
    expect(code).toBe(0);
    expect(io.error).not.toHaveBeenCalled();
  });

  it("rejects a non-positive-integer cap with a clear error", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "two-binary-steps.workflow.json"), "--llm-concurrency", "0"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--llm-concurrency/));
  });
});
