import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { LlmWorker, PromptRequest, PromptResult } from "../src/llm/llm-worker.js";
import { createDbLogBackend } from "../src/logging/db-backend.js";
import { LOG_FORMAT } from "../src/logging/log-backend.js";
import { openDb } from "../src/persistence/db.js";
import { dbFilePath } from "../src/persistence/paths.js";
import { finishRun, insertRun } from "../src/persistence/run-store.js";

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

describe("cli main() — --context / --set-context (ticket #171)", () => {
  function contextEcho() {
    return join(fixtures, "context-echo.workflow.json");
  }

  it("--set-context seeds the run's starting context, readable via ${context.x}", async () => {
    const io = fakeIo();
    const code = await main(["run", contextEcho(), "--set-context", "greeting=operator-value"], io);
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "operator-value" }));
  });

  it("--context loads a whole object that seeds the starting context", async () => {
    const io = fakeIo();
    const code = await main(["run", contextEcho(), "--context", join(fixtures, "context-override.json")], io);
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "context-file-value" }));
  });

  it("--set-context wins over --context when both touch the same key", async () => {
    const io = fakeIo();
    const code = await main(
      [
        "run",
        contextEcho(),
        "--context",
        join(fixtures, "context-override.json"),
        "--set-context",
        "greeting=set-context-value",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "set-context-value" }));
  });

  it("reports a clear error for a malformed --set-context argument", async () => {
    const io = fakeIo();
    const code = await main(["run", contextEcho(), "--set-context", "no-equals-sign"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--set-context/));
  });

  it("reports a clear error when --context points at a missing file", async () => {
    const io = fakeIo();
    const code = await main(["run", contextEcho(), "--context", join(fixtures, "nope.json")], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--context/));
  });

  it("reports a clear error when --context file is not a JSON object", async () => {
    const io = fakeIo();
    const code = await main(["run", contextEcho(), "--context", join(fixtures, "context-array.json")], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--context.*must contain a JSON object/));
  });
});

describe("cli main() — --resume (ticket #177)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-engine-resume-cli-"));
    cpSync(join(realFixtures, "resumable.workflow.json"), join(projectDir, "workflow.json"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  const workflow = () => join(projectDir, "workflow.json");

  // Combining a context seed with --resume is a hard validation error, not a silent drop (ADR 0003):
  // a resumed run's starting context is already fully determined by restore-by-load.
  it("rejects --context combined with --resume as a validation error (exit 2)", async () => {
    const io = fakeIo();
    const code = await main(["run", workflow(), "--resume", "whatever", "--context", join(fixtures, "context-override.json")], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--context.*--resume|--resume.*--context/));
  });

  it("rejects --set-context combined with --resume as a validation error (exit 2)", async () => {
    const io = fakeIo();
    const code = await main(["run", workflow(), "--resume", "whatever", "--set-context", "k=v"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--set-context|--context/));
  });

  it("reports a clear error when --resume has no id argument (exit 2)", async () => {
    const io = fakeIo();
    const code = await main(["run", workflow(), "--resume"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--resume/));
  });

  it("exits 1 with a clear error when --resume names an unknown root run id", async () => {
    const io = fakeIo();
    const code = await main(["run", workflow(), "--resume", "no-such-root"], io);
    expect(code).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/no run found.*no-such-root/));
    expect(io.log).not.toHaveBeenCalled();
  });

  it("prints the successor's root run id and exits 1 when the resumed run itself fails again", async () => {
    const firstIo = fakeIo();
    expect(await main(["run", workflow()], firstIo)).toBe(1);

    const db = openDb(dbFilePath(projectDir));
    const originalRoot = (
      db.prepare("SELECT root_run_id FROM runs WHERE run_id = root_run_id AND resumed_from_root_run_id IS NULL LIMIT 1").get() as {
        root_run_id: string;
      }
    ).root_run_id;
    db.close();

    // Resume without fixing the config, so step-b fails again — the successor id must still print on
    // this non-success outcome (#168 story 24), so the operator can inspect it or chain a further
    // --resume regardless of how it ended.
    const io = fakeIo();
    const code = await main(["run", workflow(), "--resume", originalRoot], io);
    expect(code).toBe(1);
    const successorRoot = io.log.mock.calls.at(-1)![0] as string;
    expect(successorRoot).not.toBe(originalRoot);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/run failed/));
  });

  it("resumes a failed run, reuses the succeeded step, and prints the successor's root run id", async () => {
    // First run fails at step-b (config mode defaults to "fail"); step-a succeeds.
    const firstIo = fakeIo();
    const firstCode = await main(["run", workflow()], firstIo);
    expect(firstCode).toBe(1);

    const db = openDb(dbFilePath(projectDir));
    const originalRoot = (
      db.prepare("SELECT root_run_id FROM runs WHERE run_id = root_run_id AND resumed_from_root_run_id IS NULL LIMIT 1").get() as {
        root_run_id: string;
      }
    ).root_run_id;
    db.close();

    // Resume with a corrected config — --set feeds every rerun (criterion 3), so step-b now passes.
    const io = fakeIo();
    const code = await main(["run", workflow(), "--resume", originalRoot, "--set", "mode=ok"], io);
    expect(code).toBe(0);

    // The one stdout line is the successor's own fresh root run id, distinct from the predecessor.
    const successorRoot = io.log.mock.calls.at(-1)![0] as string;
    expect(successorRoot).not.toBe(originalRoot);

    const after = openDb(dbFilePath(projectDir));
    try {
      const successorRows = after
        .prepare("SELECT node_id, status FROM runs WHERE root_run_id = ?")
        .all(successorRoot) as { node_id: string | null; status: string }[];
      // step-a was reused: it has no run row of its own in the successor tree. step-b reran and
      // succeeded. The successor's root row records the immediate predecessor it resumed from.
      expect(successorRows.some((r) => r.node_id === "step-a")).toBe(false);
      expect(successorRows.find((r) => r.node_id === "step-b")?.status).toBe("succeeded");

      const successorRootRow = after
        .prepare("SELECT resumed_from_root_run_id FROM runs WHERE run_id = ?")
        .get(successorRoot) as { resumed_from_root_run_id: string | null };
      expect(successorRootRow.resumed_from_root_run_id).toBe(originalRoot);

      // The original tree is untouched: its rows still read exactly as the failed run left them.
      const originalRows = after
        .prepare("SELECT node_id, status FROM runs WHERE root_run_id = ?")
        .all(originalRoot) as { node_id: string | null; status: string }[];
      expect(originalRows.find((r) => r.node_id === "step-a")?.status).toBe("succeeded");
      expect(originalRows.find((r) => r.node_id === "step-b")?.status).toBe("failed");
    } finally {
      after.close();
    }
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

// `^C` cancels the run instead of killing the process (ticket #53). The press is synthetic —
// `process.emit("SIGINT")` from inside a scripted prompt step, which is the real listener firing at
// the one moment that matters (a step genuinely in flight) without a signal being sent for real.
describe("cli main() — graceful ^C (ticket #53)", () => {
  let projectDir: string;
  let sigintListenersBefore: number;

  const ONE_PROMPT_WORKFLOW = {
    format: "path/workflow@0",
    name: "sigint-cancel",
    worker: { type: "llm", model: "claude-sonnet-5" },
    body: [
      { type: "prompt", id: "ask", prompt: "Question.", publish: { answer: "${output}" } },
      { type: "prompt", id: "never", prompt: "Second question." },
    ],
    output: { result: "${context.answer}" },
  };

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-engine-sigint-cli-"));
    writeFileSync(join(projectDir, "workflow.json"), JSON.stringify(ONE_PROMPT_WORKFLOW), "utf8");
    sigintListenersBefore = process.listenerCount("SIGINT");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function runIt(llmWorker: LlmWorker, io = fakeIo(), forceExit?: (code: number) => void) {
    return main(["run", join(projectDir, "workflow.json")], io, { llmWorker, forceExit });
  }

  /**
   * A prompt step that presses `^C` `presses` times the moment it is in flight and then holds its
   * processor open until the abort reaches it — what a live Agent SDK turn does for real.
   */
  function pressingLlmWorker(presses = 1): LlmWorker {
    return {
      async runPrompt(request: PromptRequest): Promise<PromptResult> {
        for (let i = 0; i < presses; i += 1) process.emit("SIGINT");
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) {
            resolve();
            return;
          }
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "cancelled" };
      },
    };
  }

  function readRunRows() {
    const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
    const rows = db.prepare("SELECT run_id, root_run_id, node_id, status FROM runs").all() as {
      run_id: string;
      root_run_id: string;
      node_id: string | null;
      status: string;
    }[];
    db.close();
    return rows;
  }

  function readLogEvents(rootRunId: string): { type: string; [key: string]: unknown }[] {
    return readFileSync(join(projectDir, ".path", "runs", rootRunId, "run.log"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type !== "log-header");
  }

  it("cancels the run in flight and exits 130, with the row and the log agreeing", async () => {
    const io = fakeIo();
    const code = await runIt(pressingLlmWorker(), io);

    // 128 + SIGINT(2), the shell convention — distinct from the 1 a *failed* run returns.
    expect(code).toBe(130);
    expect(io.error.mock.calls.join("\n")).toMatch(/cancelling/i);
    // Forcing costs a lying `running` row that nothing reconciles (#60, mvp spec §5.6), so the
    // notice names both the cost and the remedy while the operator is deciding whether to press
    // again. Asserted loosely: the two facts must be there, the wording is free to change.
    expect(io.error.mock.calls.join("\n")).toMatch(/running/);
    expect(io.error.mock.calls.join("\n")).toMatch(/runs rm/);
    expect(io.log).not.toHaveBeenCalled(); // a cancelled run has no output contract

    const rows = readRunRows();
    const root = rows.find((r) => r.run_id === r.root_run_id)!;
    expect(root.status).toBe("cancelled"); // not the lying `running` row ^C used to leave
    expect(rows.find((r) => r.node_id === "ask")!.status).toBe("cancelled");
    expect(rows.find((r) => r.node_id === "never")).toBeUndefined(); // nothing ran after the abort

    // The NDJSON stream tells the same story, and the backends were closed on the root's terminal event.
    const events = readLogEvents(root.root_run_id);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "run-cancelled", node_id: "ask", cause: "operator", cause_run_id: null }),
    );
    expect(events.at(-1)).toMatchObject({ type: "step-finished", run_id: root.run_id, node_id: null, status: "cancelled" });
  });

  it("removes its SIGINT listener once the run settles", async () => {
    expect(await runIt(pressingLlmWorker())).toBe(130);
    expect(process.listenerCount("SIGINT")).toBe(sigintListenersBefore);
  });

  it("leaves a run that finishes normally untouched, listener included", async () => {
    const io = fakeIo();
    const llmWorker: LlmWorker = {
      async runPrompt() {
        return { status: "succeeded", output: "ok", usage: null, estimatedCostUsd: null };
      },
    };

    const code = await runIt(llmWorker, io);

    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ result: "ok" }));
    expect(io.error).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(sigintListenersBefore);
    expect(readRunRows().every((r) => r.status === "succeeded")).toBe(true);
  });

  // Cancellation is best-effort with no deadline (mvp spec §5.6), so a second press is the
  // operator's escape hatch. Asserted at the seam that decides it — a real second `^C` would take
  // the test process down with it.
  it("hands a second ^C straight to the forced exit, with the same code", async () => {
    const forceExit = vi.fn();

    const code = await runIt(pressingLlmWorker(2), fakeIo(), forceExit);

    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(130);
    // The first press still cancelled: a forced exit is an escape from the *wait*, not the cancel.
    expect(code).toBe(130);
  });

  it("does not force-exit on the first ^C, however slow the unwind", async () => {
    const forceExit = vi.fn();

    expect(await runIt(pressingLlmWorker(1), fakeIo(), forceExit)).toBe(130);

    expect(forceExit).not.toHaveBeenCalled();
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

describe("cli main() — runs subcommand argument strictness (ticket #61)", () => {
  // These must not touch a real project: `prune` deletes every run under the cwd, so a regression
  // that stops rejecting the argument would otherwise delete whatever the test happened to run in.
  it("refuses `runs prune --help` rather than pruning the project", async () => {
    const io = fakeIo();
    const code = await main(["runs", "prune", "--help"], io);
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(expect.stringMatching(/usage: path run/));
    expect(io.error).not.toHaveBeenCalled();
  });

  it("refuses any other trailing argument to `runs prune`", async () => {
    const io = fakeIo();
    const code = await main(["runs", "prune", "--older-than", "7d"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/takes no arguments, got "--older-than"/));
    expect(io.log).not.toHaveBeenCalled();
  });

  it("refuses a second id to `runs rm` instead of silently dropping it", async () => {
    const io = fakeIo();
    const code = await main(["runs", "rm", "id-one", "id-two"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/exactly one run id, got 2/));
    expect(io.log).not.toHaveBeenCalled();
  });

  it("answers --help with usage and exit 0", async () => {
    for (const argv of [["--help"], ["-h"], ["run", "--help"]]) {
      const io = fakeIo();
      const code = await main(argv, io);
      expect(code).toBe(0);
      expect(io.log).toHaveBeenCalledWith(expect.stringMatching(/usage: path run/));
    }
  });
});

describe("cli main() — runs bare listing (ticket #174)", () => {
  let projectDir: string;
  let cwd: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-engine-runs-list-"));
    // The bare listing reads the `.path/` under the cwd, like `rm`/`prune` — point the cwd at a
    // throwaway project so the assertions own every row.
    cwd = process.cwd();
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  function seedRoot(runId: string, status: string, resumedFromRootRunId?: string): void {
    const db = openDb(dbFilePath(projectDir));
    insertRun(db, {
      runId,
      rootRunId: runId,
      parentRunId: null,
      nodeId: null,
      worker: { type: "engine" },
      status: "running",
      resumedFromRootRunId: resumedFromRootRunId ?? null,
    });
    if (status !== "running") finishRun(db, runId, status as "succeeded" | "failed" | "cancelled");
    db.close();
  }

  // `started`/`finished` are real `new Date().toISOString()` values (run-store.ts), so table tests
  // split each line into cells on the 2+-space column separator and check timestamp cells by shape
  // rather than by exact string.
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const cellsOf = (line: string): string[] => line.trim().split(/\s{2,}/);

  it("lists roots most-recent-first with space-aligned columns and every resumed-from form", async () => {
    seedRoot("run-aaa", "running");
    seedRoot("run-bbb", "succeeded", "run-aaa"); // live predecessor
    seedRoot("run-ccc", "failed", "ghost"); // predecessor no longer in `runs`

    const io = fakeIo();
    const code = await main(["runs"], io);

    expect(code).toBe(0);
    expect(io.error).not.toHaveBeenCalled();
    const lines = (io.log.mock.calls.at(-1)![0] as string).split("\n");
    expect(lines).toHaveLength(4);
    expect(cellsOf(lines[0]!)).toEqual(["root-run-id", "status", "started", "finished", "resumed-from"]);

    const [ccc, bbb, aaa] = lines.slice(1).map(cellsOf);
    expect(ccc).toEqual(["run-ccc", "failed", expect.stringMatching(ISO_RE), expect.stringMatching(ISO_RE), "ghost (deleted)"]);
    expect(bbb).toEqual(["run-bbb", "succeeded", expect.stringMatching(ISO_RE), expect.stringMatching(ISO_RE), "run-aaa"]);
    expect(aaa).toEqual(["run-aaa", "running", expect.stringMatching(ISO_RE), "-", "-"]);
  });

  it("renders a predecessor off the current --limit page as live, not deleted", async () => {
    seedRoot("older-root", "succeeded"); // the predecessor, pushed off the page by --limit 1
    seedRoot("newer-root", "succeeded", "older-root");

    const io = fakeIo();
    const code = await main(["runs", "--limit", "1"], io);

    expect(code).toBe(0);
    const lines = (io.log.mock.calls.at(-1)![0] as string).split("\n");
    expect(lines).toHaveLength(2);
    expect(cellsOf(lines[1]!)).toEqual([
      "newer-root",
      "succeeded",
      expect.stringMatching(ISO_RE),
      expect.stringMatching(ISO_RE),
      "older-root",
    ]);
    const output = lines.join("\n");
    expect(output).not.toMatch(/older-root +succeeded/); // capped off the page
    expect(output).not.toContain("(deleted)"); // liveness is existence, not page membership
  });

  it("filters by --status", async () => {
    seedRoot("ok-run", "succeeded");
    seedRoot("bad-run", "failed");

    const io = fakeIo();
    const code = await main(["runs", "--status", "failed"], io);

    expect(code).toBe(0);
    const output = io.log.mock.calls.at(-1)![0] as string;
    expect(output).toContain("bad-run");
    expect(output).not.toContain("ok-run");
  });

  it("prints only the header for a project with no runs", async () => {
    const io = fakeIo();
    const code = await main(["runs"], io);

    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith("root-run-id  status  started  finished  resumed-from");
  });

  it("rejects an unknown --status value with a usage error", async () => {
    const io = fakeIo();
    const code = await main(["runs", "--status", "bogus"], io);

    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--status requires one of/));
    expect(io.log).not.toHaveBeenCalled();
  });

  it("rejects a non-positive --limit with a usage error", async () => {
    const io = fakeIo();
    const code = await main(["runs", "--limit", "0"], io);

    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--limit requires a positive integer/));
  });

  it("still reports a mistyped subcommand as a usage error", async () => {
    const io = fakeIo();
    const code = await main(["runs", "bogus"], io);

    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/usage: path runs/));
    expect(io.log).not.toHaveBeenCalled();
  });
});

describe("cli main() — runs rm reuse-marker guard (ticket #175)", () => {
  let projectDir: string;
  let cwd: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-engine-rm-guard-"));
    cwd = process.cwd();
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  function seedRoot(runId: string, childNodeId = "greet"): void {
    const db = openDb(dbFilePath(projectDir));
    insertRun(db, { runId, rootRunId: runId, parentRunId: null, nodeId: null, worker: { type: "engine" }, status: "succeeded" });
    insertRun(db, {
      runId: `${runId}-child`,
      rootRunId: runId,
      parentRunId: runId,
      nodeId: childNodeId,
      worker: { type: "engine" },
      status: "succeeded",
    });
    db.close();
  }

  /** Write a reuse-marker into `holder`'s log naming a run in the original tree — what a resume does. */
  async function seedReuseMarker(holderRootRunId: string, originalRunId: string): Promise<void> {
    const db = openDb(dbFilePath(projectDir));
    const backend = createDbLogBackend(db);
    await backend.open({ runId: holderRootRunId, format: LOG_FORMAT });
    await backend.write({
      type: "reuse-marker",
      seq: 1,
      ts: new Date().toISOString(),
      run_id: holderRootRunId,
      node_id: "greet",
      original_run_id: originalRunId,
    });
    await backend.close();
    db.close();
  }

  it("refuses by default when a live successor reuses the target, and deletes nothing", async () => {
    seedRoot("target");
    seedRoot("successor");
    await seedReuseMarker("successor", "target-child");

    const io = fakeIo();
    const code = await main(["runs", "rm", "target"], io);

    expect(code).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/refusing to remove target.*successor/s));
    expect(io.log).not.toHaveBeenCalled();
    // The target still exists — a refused delete removes nothing.
    const check = fakeIo();
    await main(["runs"], check);
    expect((check.log.mock.calls.at(-1)![0] as string)).toContain("target");
  });

  it("--force overrides the block, deletes only the named tree, and names the orphaned successor", async () => {
    seedRoot("target");
    seedRoot("successor");
    await seedReuseMarker("successor", "target-child");

    const io = fakeIo();
    const code = await main(["runs", "rm", "--force", "target"], io);

    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith("removed run target");
    expect(io.log).toHaveBeenCalledWith("orphaned successor run(s): successor");
    // No cascade: the successor it orphaned is still present.
    const check = fakeIo();
    await main(["runs"], check);
    const listing = check.log.mock.calls.at(-1)![0] as string;
    expect(listing).toContain("successor");
    expect(listing).not.toMatch(/^target /m);
  });

  it("deletes with no orphan note when nothing reuses the target", async () => {
    seedRoot("target");

    const io = fakeIo();
    const code = await main(["runs", "rm", "target"], io);

    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith("removed run target");
    expect(io.log).not.toHaveBeenCalledWith(expect.stringMatching(/orphaned/));
  });

  it("still reports a not-found id, even under --force", async () => {
    const io = fakeIo();
    const code = await main(["runs", "rm", "--force", "never-ran"], io);

    expect(code).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/no run found with id "never-ran"/));
  });

  it("rejects an unknown flag with a usage error", async () => {
    const io = fakeIo();
    const code = await main(["runs", "rm", "--frce", "target"], io);

    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/unknown flag "--frce"/));
  });
});
