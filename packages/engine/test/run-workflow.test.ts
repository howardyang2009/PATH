import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowFile, type ConfigObject, type WorkflowFile } from "@path/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmWorker, PromptRequest, PromptResult } from "../src/llm/llm-worker.js";
import { DEFAULT_LLM_CONCURRENCY } from "../src/llm/processor-semaphore.js";
import { fakeObserver, type FakeObserver } from "./fake-observer.js";
import type { Observation, RunObserver } from "../src/run-observer.js";
import { runWorkflow } from "../src/run-workflow.js";
import { stampGuids, stampNames } from "./stamp-names.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): WorkflowFile {
  return parseWorkflowFile(JSON.parse(readFileSync(join(fixturesDir, name), "utf8")));
}

function echoStdinScript() {
  return "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))";
}

describe("runWorkflow — walking-skeleton basics (ticket #16, still true under #17)", () => {
  it("threads the first binary step's stdout into the second step's stdin (default-input chain)", async () => {
    const file = loadFixture("two-binary-steps.workflow.json");
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("succeeded");
  });

  it("fails fast on a non-zero exit and does not run subsequent steps", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "fail-fast",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "boom", name: "boom", command: "node", args: ["-e", "process.exit(3)"] },
        { type: "binary", id: "never", name: "never", command: "node", args: ["-e", "process.stdout.write('nope')"] },
      ],
    };
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/boom/);
    expect(result.error).toMatch(/\b3\b/);
  });

  it("acceptance: races two binary sleeps under wait-one — the shorter wins, the longer is cancelled sibling-succeeded", async () => {
    // The real file, through the real schema: two branches publishing the same key `answer` — which
    // `collect` would reject at load, but `wait-one` allows because only the winner's publish lands.
    const file = parseWorkflowFile(stampGuids({
      format: "path/workflow@2",
      id: "wf-id",
      name: "race-two-sleeps",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "race", name: "race",
          join: "wait-one",
          branches: [
            {
              type: "sequence", id: "fast", name: "fast",
              body: [
                {
                  type: "binary",
                  id: "quick", name: "quick",
                  command: "node",
                  args: ["-e", "setTimeout(()=>process.stdout.write('FAST'),10)"],
                  publish: { answer: "${output}" },
                },
              ],
            },
            {
              type: "sequence", id: "slow", name: "slow",
              body: [
                {
                  type: "binary",
                  id: "sluggish", name: "sluggish",
                  command: "node",
                  args: ["-e", "setTimeout(()=>process.stdout.write('SLOW'),5000)"],
                  publish: { answer: "${output}" },
                },
              ],
            },
          ],
        },
      ],
      output: { answer: "${context.answer}" },
    }));

    const observer = fakeObserver();
    const result = await runWorkflow(file, fixturesDir, { observer });

    // The winner landed; the loser's publish never did.
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ answer: "FAST" });

    const all = observer.all();
    // The join names the winner (by human name) and lands only its key.
    expect(all.find((o) => o.type === "join-applied")).toMatchObject({
      nodeName: "race",
      branches: ["fast"],
      publishedKeys: ["answer"],
      winner: "fast",
    });
    // The longer branch was cancelled best-effort, with the new cause and no cause run behind it.
    const cancelled = all.find((o) => o.type === "run-cancelled");
    expect(cancelled).toMatchObject({ nodeName: "sluggish", cause: "sibling-succeeded", causeRunId: null });
    // And it ends `cancelled`, a distinct status from `failed`, so nothing of its lands.
    expect(
      all.some((o) => o.type === "step-finished" && o.status === "cancelled" && o.runId === cancelled!.runId),
    ).toBe(true);
  });

  it("acceptance: every wait-one branch fails — the block fails to a synthetic aggregate, no winner lands (#196)", async () => {
    // Both arms exit non-zero. A failing wait-one branch cancels nothing (§2), so the race runs to
    // exhaustion and, with no winner, the block fails to the aggregate — not a copy of either arm's error.
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "all-fail-wait-one",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "race", name: "race",
          join: "wait-one",
          branches: [
            { type: "sequence", id: "arm-a", name: "arm-a", body: [{ type: "binary", id: "boom-a", name: "boom-a", command: "node", args: ["-e", "process.exit(7)"] }] },
            { type: "sequence", id: "arm-b", name: "arm-b", body: [{ type: "binary", id: "boom-b", name: "boom-b", command: "node", args: ["-e", "process.exit(9)"] }] },
          ],
        },
      ],
    };

    const result = await runWorkflow(stampNames(file), fixturesDir, { observer });

    // The block fails with the synthetic aggregate, distinct from either arm's exit-code error (§2).
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/all 2 wait-one branches failed/);
    expect(result.error).not.toMatch(/\b7\b/);
    expect(result.error).not.toMatch(/\b9\b/);

    const all = observer.all();
    // No winner, so no join lands (§8)...
    expect(observer["join-applied"]).not.toHaveBeenCalled();
    // ...and nothing was cancelled sibling-succeeded — each branch died on its own (§2).
    expect(all.some((o) => o.type === "run-cancelled" && o.cause === "sibling-succeeded")).toBe(false);

    // Each branch's own failure is still recorded on its own run row (nodeId lands on step-started,
    // so map each arm's node to its run and assert that run's step-finished is `failed`).
    const failedRunIds = new Set(
      all.filter((o) => o.type === "step-finished" && o.status === "failed").map((o) => o.runId),
    );
    for (const nodeId of ["boom-a", "boom-b"]) {
      const started = all.find((o) => o.type === "step-started" && o.nodeId === nodeId);
      expect(started, `step-started for ${nodeId}`).toBeDefined();
      expect(failedRunIds.has(started!.runId)).toBe(true);
    }
  });

  it("respects a step's own cwd override", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "cwd-check",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "pwd", name: "pwd",
          command: "node",
          args: ["-e", "process.stdout.write(process.cwd())"],
          cwd: fixturesDir,
        },
      ],
    };
    const result = await runWorkflow(stampNames(file), "/tmp");
    expect(result.status).toBe("succeeded");
  });

  it("resolves a relative cwd against the workflow file's directory, not the process's", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "relative-cwd",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "pwd", name: "pwd",
          command: "node",
          args: ["-e", "process.stdout.write(process.cwd())"],
          // `.` is what the acceptance pipeline's `repo_path` default is; anchoring it to the
          // caller's shell would make the same workflow behave differently per invocation.
          cwd: ".",
          publish: { pwd: "${output}" },
        },
      ],
      output: { pwd: "${context.pwd}" },
    };
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ pwd: realpathSync(fixturesDir) });
  });

  it("fails clearly on unsupported node types instead of silently skipping them", async () => {
    // Every node type the format declares now executes (#25 completed the set with `prompt`), so
    // reaching this guard takes a node the schema itself would reject. It stays for the case of a
    // new type landing in the format before the engine walks it: fail loudly, never skip.
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "unknown-node",
      worker: { type: "engine" },
      body: [{ type: "telepathy", id: "guess" } as unknown as WorkflowFile["body"][number]],
    };
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/telepathy/);
  });
});

describe("runWorkflow — do-not-wait launch-and-continue (ticket #213)", () => {
  it("acceptance: launches a branch, discharges {} to the successor at once, and waits for the branch at the exit barrier", async () => {
    // One detached branch that takes 80ms, then an instant successor. Launch-and-continue means the
    // successor runs against the block's `{}` output without waiting for the branch; the enclosing-run
    // barrier means the run does not finish until the branch is terminal (do-not-wait-join.md §2/§1.1).
    const file = parseWorkflowFile(stampGuids({
      format: "path/workflow@2",
      id: "wf-id",
      name: "fire-and-continue",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "fire", name: "fire",
          join: "do-not-wait",
          branches: [
            {
              type: "sequence", id: "notify", name: "notify",
              body: [
                {
                  type: "binary",
                  id: "slow-notify", name: "slow-notify",
                  command: "node",
                  args: ["-e", "setTimeout(()=>process.stdout.write('SENT'),80)"],
                },
              ],
            },
          ],
        },
        // The successor's default input is the block's output; it echoes its stdin, so its stdout is
        // exactly what the block handed downstream — `{}` serialized.
        {
          type: "binary",
          id: "after", name: "after",
          command: "node",
          args: ["-e", echoStdinScript()],
          publish: { seen: "${output}" },
        },
      ],
      output: { seen: "${context.seen}" },
    }));

    const observer = fakeObserver();
    const result = await runWorkflow(file, fixturesDir, { observer });

    // The block discharged the empty object; the successor saw `{}` on stdin (§2, §3).
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ seen: "{}" });

    const all = observer.all();
    const runIdOf = (nodeName: string) =>
      all.find((o) => o.type === "step-started" && o.nodeName === nodeName)!.runId;
    const finishedOf = (nodeName: string) =>
      all.find((o) => o.type === "step-finished" && o.runId === runIdOf(nodeName))!;
    const finishedIndexOf = (nodeName: string) =>
      all.findIndex((o) => o.type === "step-finished" && o.runId === runIdOf(nodeName));

    // Launch-and-continue: the successor finished before the 80ms branch, so it did not wait on it.
    expect(finishedIndexOf("after")).toBeLessThan(finishedIndexOf("slow-notify"));

    // Barrier: the detached branch reached `succeeded`, and it did so before the root run finished —
    // the run never returned with the branch still live.
    expect(finishedOf("slow-notify")).toMatchObject({ status: "succeeded" });
    const rootFinishedIndex = all.findIndex((o) => o.type === "run-finished" && o.runId === o.rootRunId);
    expect(finishedIndexOf("slow-notify")).toBeLessThan(rootFinishedIndex);
  });

  it("emits join-applied at the do-not-wait join with no winner and no landed keys (§9)", async () => {
    const file = parseWorkflowFile(stampGuids({
      format: "path/workflow@2",
      id: "wf-id",
      name: "fire-once",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "fire", name: "fire",
          join: "do-not-wait",
          branches: [
            {
              type: "sequence", id: "notify", name: "notify",
              body: [{ type: "binary", id: "ping", name: "ping", command: "node", args: ["-e", "process.stdout.write('ok')"] }],
            },
          ],
        },
      ],
    }));

    const observer = fakeObserver();
    const result = await runWorkflow(file, fixturesDir, { observer });
    expect(result.status).toBe("succeeded");

    const join = observer.all().find((o) => o.type === "join-applied");
    // The join marks only that the block resolved: the launched branch is named, nothing landed, and
    // there is no winner (that field is wait-one-only).
    expect(join).toMatchObject({ nodeName: "fire", branches: ["notify"], publishedKeys: [] });
    expect(join).not.toHaveProperty("winner");
  });
});

describe("runWorkflow — do-not-wait failure isolation (ticket #214, ADR 0008)", () => {
  // Map a node name to the run row the engine minted for it, via `step-started`.
  const runIdOf = (all: Observation[], nodeName: string) =>
    all.find((o) => o.type === "step-started" && o.nodeName === nodeName)!.runId;
  const finishedOf = (all: Observation[], nodeName: string) =>
    all.find((o) => o.type === "step-finished" && o.runId === runIdOf(all, nodeName))!;

  it("acceptance: a failed detached branch does not fail the run — the row is `failed`, the run ends `succeeded`", async () => {
    // The demoable case (§5, ADR 0008): a detached branch exits non-zero while the main path
    // succeeds. The block discharged at the join, so the run ends on its main path alone — `succeeded`
    // — with the branch's `failed` recorded on its own run row and narrated by its own `step-finished`.
    const file = parseWorkflowFile(stampGuids({
      format: "path/workflow@2",
      id: "wf-id",
      name: "fire-and-fail",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "fire", name: "fire",
          join: "do-not-wait",
          branches: [
            {
              type: "sequence", id: "doomed", name: "doomed",
              body: [{ type: "binary", id: "boom", name: "boom", command: "node", args: ["-e", "process.exit(7)"] }],
            },
          ],
        },
        { type: "binary", id: "after", name: "after", command: "node", args: ["-e", "process.stdout.write('ok')"] },
      ],
    }));

    const observer = fakeObserver();
    const result = await runWorkflow(file, fixturesDir, { observer });

    // A run may end `succeeded` with a `failed` do-not-wait descendant in its subtree.
    expect(result.status).toBe("succeeded");

    const all = observer.all();
    // The failure is auditable, not hidden: the branch's own run row ends `failed`.
    expect(finishedOf(all, "boom")).toMatchObject({ status: "failed" });
    // Isolation is about propagation, not cancellation — the failure cancelled nothing.
    expect(all.some((o) => o.type === "run-cancelled")).toBe(false);
    // And the root run itself ended `succeeded`.
    const rootFinished = all.find((o) => o.type === "run-finished" && o.runId === o.rootRunId)!;
    expect(rootFinished).toMatchObject({ status: "succeeded" });
  });

  it("a detached branch failure cancels neither its siblings nor the main path (§5, §6)", async () => {
    // Two detached siblings: one exits non-zero at once, the other sleeps then succeeds. A `collect`
    // failure would cross-cancel the in-flight sibling (`sibling-failed`); do-not-wait cancels nothing.
    // The surviving sibling runs to `succeeded` and the main path is untouched.
    const file = parseWorkflowFile(stampGuids({
      format: "path/workflow@2",
      id: "wf-id",
      name: "fail-one-keep-other",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "fire", name: "fire",
          join: "do-not-wait",
          branches: [
            {
              type: "sequence", id: "doomed", name: "doomed",
              body: [{ type: "binary", id: "boom", name: "boom", command: "node", args: ["-e", "process.exit(7)"] }],
            },
            {
              type: "sequence", id: "survivor", name: "survivor",
              body: [{ type: "binary", id: "slow-ok", name: "slow-ok", command: "node", args: ["-e", "setTimeout(()=>process.stdout.write('ok'),80)"] }],
            },
          ],
        },
        { type: "binary", id: "after", name: "after", command: "node", args: ["-e", "process.stdout.write('ok')"] },
      ],
    }));

    const observer = fakeObserver();
    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("succeeded");

    const all = observer.all();
    // The failing branch is `failed`; the in-flight sibling survived to `succeeded`, not cancelled.
    expect(finishedOf(all, "boom")).toMatchObject({ status: "failed" });
    expect(finishedOf(all, "slow-ok")).toMatchObject({ status: "succeeded" });
    expect(finishedOf(all, "after")).toMatchObject({ status: "succeeded" });
    // Nothing was cancelled at all — no cross-cancel path exists for do-not-wait.
    expect(all.some((o) => o.type === "run-cancelled")).toBe(false);
  });

  it("adds no new run-cancelled cause; an operator root-cancel reaches an in-flight detached branch under `operator` (§6)", async () => {
    // A detached branch and the main path both sleep long enough to still be live when the operator
    // aborts the root. do-not-wait adds no sibling-driven cancel path, so the only abort that reaches
    // the branch is the existing operator one, and it lands under the existing cause `operator`.
    const file = parseWorkflowFile(stampGuids({
      format: "path/workflow@2",
      id: "wf-id",
      name: "operator-cancels-detached",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "fire", name: "fire",
          join: "do-not-wait",
          branches: [
            {
              type: "sequence", id: "detached", name: "detached",
              body: [{ type: "binary", id: "detached-work", name: "detached-work", command: "node", args: ["-e", "setTimeout(()=>{},5000)"] }],
            },
          ],
        },
        { type: "binary", id: "main-work", name: "main-work", command: "node", args: ["-e", "setTimeout(()=>{},5000)"] },
      ],
    }));

    const observer = fakeObserver();
    const controller = new AbortController();
    const pending = runWorkflow(file, fixturesDir, { observer, signal: controller.signal });
    // Let both the branch and the main path get in flight, then abort the root.
    await new Promise((r) => setTimeout(r, 120));
    controller.abort();
    await pending;

    const all = observer.all();
    // The operator abort reached the detached branch's leaf, under the pre-existing cause `operator`.
    const branchCancel = all.find(
      (o) => o.type === "run-cancelled" && o.nodeName === "detached-work",
    );
    expect(branchCancel).toMatchObject({ cause: "operator", causeRunId: null });
    // No new cancel cause: every cancellation on this path is `operator` — do-not-wait added no
    // sibling-driven path, so nothing here reads `sibling-failed`, `sibling-succeeded`, or anything else.
    const causes = all.filter((o) => o.type === "run-cancelled").map((o) => (o as Extract<Observation, { type: "run-cancelled" }>).cause);
    expect(causes.length).toBeGreaterThan(0);
    expect(causes.every((c) => c === "operator")).toBe(true);
  });

  it("sums a failed detached branch's token usage into the roll-up, final before the run returns (§8)", async () => {
    // The roll-up is status-blind: a detached branch that burned tokens and then `failed` still spent
    // them. The enclosing-run barrier holds the run open until the branch is terminal, so its
    // `step-usage` is emitted before the run finishes — the spend is final at roll-up time.
    const worker: LlmWorker = {
      async runPrompt() {
        await new Promise((r) => setTimeout(r, 60));
        return { status: "failed", error: "sink rejected", usage: { input_tokens: 11, output_tokens: 7 }, estimatedCostUsd: 0.002 };
      },
    };
    const file = parseWorkflowFile(stampGuids({
      format: "path/workflow@2",
      id: "wf-id",
      name: "detached-spend-counts",
      worker: { type: "llm", model: "claude-sonnet-5" },
      body: [
        {
          type: "parallel",
          id: "fire", name: "fire",
          join: "do-not-wait",
          branches: [
            {
              type: "sequence", id: "telemetry", name: "telemetry",
              body: [{ type: "prompt", id: "emit", name: "emit", prompt: "Emit to the slow sink." }],
            },
          ],
        },
        { type: "binary", id: "after", name: "after", command: "node", args: ["-e", "process.stdout.write('ok')"] },
      ],
    }));

    const observer = fakeObserver();
    const result = await runWorkflow(file, fixturesDir, { observer, llmWorker: worker });

    expect(result.status).toBe("succeeded");

    const all = observer.all();
    // The failed branch's spend is present on its own leaf run — status-blind accounting.
    const usageIdx = all.findIndex(
      (o) => o.type === "step-usage" && o.runId === runIdOf(all, "emit"),
    );
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect((all[usageIdx] as Extract<Observation, { type: "step-usage" }>).usage).toEqual({ input_tokens: 11, output_tokens: 7 });
    expect(finishedOf(all, "emit")).toMatchObject({ status: "failed" });
    // The barrier guarantees the spend landed before the run returned: usage precedes run-finished.
    const rootFinishedIdx = all.findIndex((o) => o.type === "run-finished" && o.runId === o.rootRunId);
    expect(usageIdx).toBeLessThan(rootFinishedIdx);
  });
});

describe("runWorkflow — config interpolation and inheritance (ticket #17)", () => {
  function configEchoFile(stepConfig?: ConfigObject): WorkflowFile {
    return {
      format: "path/workflow@2",
      id: "wf-id",
      name: "config-echo",
      worker: { type: "engine" },
      config: { greeting: "file-default" },
      body: [
        {
          type: "binary",
          id: "echo", name: "echo",
          command: "node",
          args: ["-e", "process.stdout.write(process.argv[1])", "${config.greeting}"],
          ...(stepConfig ? { config: stepConfig } : {}),
        },
      ],
    };
  }

  it("uses the file's config default when nothing overrides it", async () => {
    const result = await runWorkflow(stampNames(configEchoFile()), fixturesDir);
    expect(result.status).toBe("succeeded");
  });

  it("operator config overrides the file's config default, nearest wins", async () => {
    const file = configEchoFile();
    // RunResult.output on success is the workflow output map, not the raw step output — surface
    // what the step actually received via publish + a matching output map entry.
    (file.body[0] as { publish?: Record<string, unknown> }).publish = { seen: "${output}" };
    file.output = { seen: "${context.seen}" };

    const result = await runWorkflow(stampNames(file), fixturesDir, { operatorConfig: { greeting: "operator-override" } });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ seen: "operator-override" });
  });

  it("a step-level config override wins over both file default and operator config", async () => {
    const file = configEchoFile({ greeting: "step-override" });
    (file.body[0] as { publish?: Record<string, unknown> }).publish = { seen: "${output}" };
    file.output = { seen: "${context.seen}" };

    const result = await runWorkflow(stampNames(file), fixturesDir, { operatorConfig: { greeting: "operator-override" } });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ seen: "step-override" });
  });
});

describe("runWorkflow — secret masking at the persistence boundary (ticket #20)", () => {
  const SECRET = "super-secret-abcdef";

  // A binary step that writes its argv secret to both stdout and stderr, then publishes it into
  // context and surfaces it as workflow output — so the real value touches every persisted surface.
  function secretLeakFile(): WorkflowFile {
    return {
      format: "path/workflow@2",
      id: "wf-id",
      name: "secret-leak",
      worker: { type: "engine" },
      config: { apiKey: { $secret: SECRET } },
      body: [
        {
          type: "binary",
          id: "leak", name: "leak",
          command: "node",
          args: ["-e", "process.stdout.write(process.argv[1]);process.stderr.write('E'+process.argv[1])", "${config.apiKey}"],
          publish: { saved: "${output}" },
        },
      ],
      output: { result: "${context.saved}" },
    };
  }

  // Captures every observation as it crosses the persistence boundary — this stands in for what
  // would otherwise be written to disk / a backend. It records the whole union rather than a
  // hand-listed subset: the version this replaced listed the same six hooks the masking wrapper
  // implemented, so it could not see the eight that wrapper dropped (#62).
  function recordingObserver(): { observer: FakeObserver; persisted: () => string } {
    const observer = fakeObserver();
    return { observer, persisted: () => JSON.stringify(observer.all()) };
  }

  it("hands the worker the real secret but scrubs it from every persisted payload", async () => {
    const { observer, persisted } = recordingObserver();
    const result = await runWorkflow(stampNames(secretLeakFile()), fixturesDir, { observer });

    // The spawned process received the real value, and `RunResult.output` — the run's product, and
    // what the CLI prints on success — still carries it. Only `error` is masked (#123).
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ result: SECRET });

    // Nothing crossing the persistence boundary leaks the real value; the token stands in for it.
    const dump = persisted();
    expect(dump).not.toContain(SECRET);
    expect(dump).toContain("[secret:apiKey]");
  });

  // A failing variant of the same step: the secret still reaches stderr, and the non-zero exit puts
  // the tail of that stderr into the run's error string.
  function secretLeakFailingFile(): WorkflowFile {
    const file = secretLeakFile();
    (file.body[0] as { args: string[] }).args = [
      "-e",
      "process.stderr.write('E'+process.argv[1]);process.exit(3)",
      "${config.apiKey}",
    ];
    return file;
  }

  it("masks the secret out of RunResult.error, the field every caller prints on failure (#123)", async () => {
    const result = await runWorkflow(stampNames(secretLeakFailingFile()), fixturesDir);

    expect(result.status).toBe("failed");
    // The caller's copy is masked too, not only the persisted one: `cli.ts` prints `runResult.error`
    // on its own stderr, which in CI is a retained build log — an audit surface nobody chose.
    expect(result.error).toContain("[secret:apiKey]");
    expect(result.error).not.toContain(SECRET);
  });

  it("masks `output` on a run that did not succeed — there is no product to be owed (#123)", async () => {
    // A run that fails carries its *input* back as `output` (there is no output contract on a failed
    // run), so this is what a caller handing the engine a value that is also a declared secret gets
    // back. Real on success, masked otherwise: the rule is about the product, and a failed run has
    // none.
    const result = await runWorkflow(stampNames(secretLeakFailingFile()), fixturesDir, { input: { carried: SECRET } });

    expect(result.status).toBe("failed");
    expect(result.output).toEqual({ carried: "[secret:apiKey]" });
  });

  it("leaves the run-start failure message intact — it names variables, never values (#123)", async () => {
    const file = secretLeakFile();
    // A *set* secret beside the unset variable, deliberately: with only the unset one the masker
    // collects an unresolved wrapper, `maskString` coerces it to "[object Object]" and scrubs
    // nothing — the test would pass against a masker that cannot garble anything. The set secret is
    // what makes the pass mean something.
    file.config = { apiKey: { $secret: SECRET }, other: { $secret: { $env: "PATH_TEST_UNSET_SECRET_123" } } };

    const result = await runWorkflow(stampNames(file), fixturesDir);

    // The unset-variable message rides the same masked `error` field. It names variables and config
    // keys, never values, so a live masker has nothing in it to scrub — this pins that.
    expect(result.status).toBe("failed");
    expect(result.error).toContain("PATH_TEST_UNSET_SECRET_123");
    expect(result.error).toContain('config key "other"');
    expect(result.error).not.toContain("[secret:");
  });

  it("emits a load-time warning for a short secret", async () => {
    const file = secretLeakFile();
    file.config = { pin: { $secret: "ab" } };
    const warn = vi.fn();

    await runWorkflow(stampNames(file), fixturesDir, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pin/));
  });
});

describe("runWorkflow — $env resolution at run start (ticket #116)", () => {
  const VALUE = "env-sourced-token-value";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // A binary step that writes the config value it was given to stdout and publishes it, so what the
  // worker actually received is what the run's output carries.
  function envEchoFile(config: ConfigObject, path = "config.token"): WorkflowFile {
    return {
      format: "path/workflow@2",
      id: "wf-id",
      name: "env-echo",
      worker: { type: "engine" },
      config,
      body: [
        {
          type: "binary",
          id: "echo", name: "echo",
          command: "node",
          args: ["-e", "process.stdout.write(process.argv[1])", `\${${path}}`],
          publish: { seen: "${output}" },
        },
      ],
      output: { seen: "${context.seen}" },
    };
  }

  it("resolves a plain wrapper into the value the worker receives", async () => {
    vi.stubEnv("PATH_TEST_TOKEN", VALUE);
    const result = await runWorkflow(stampNames(envEchoFile({ token: { $env: "PATH_TEST_TOKEN" } })), fixturesDir);

    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ seen: VALUE });
  });

  it("resolves a wrapper nested deep inside a config value", async () => {
    vi.stubEnv("PATH_TEST_TOKEN", VALUE);
    const file = envEchoFile({ creds: { headers: [{ auth: { $env: "PATH_TEST_TOKEN" } }] } }, "config.creds.headers.0.auth");

    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.output).toEqual({ seen: VALUE });
  });

  it("resolves operator config alongside the file's own", async () => {
    vi.stubEnv("PATH_TEST_TOKEN", VALUE);
    const file = envEchoFile({ token: "file-default" });

    const result = await runWorkflow(stampNames(file), fixturesDir, { operatorConfig: { token: { $env: "PATH_TEST_TOKEN" } } });
    expect(result.output).toEqual({ seen: VALUE });
  });

  it("resolves a step's own config inside a control block", async () => {
    // The run-start sweep and the step's effective config both have to reach a step nested in a
    // branch arm — a top-level `file.body` loop sees neither.
    vi.stubEnv("PATH_TEST_TOKEN", VALUE);
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "env-in-block",
      worker: { type: "engine" },
      body: [
        {
          type: "branch",
          id: "pick", name: "pick",
          arms: [],
          else: {
            type: "binary",
            id: "echo", name: "echo",
            command: "node",
            args: ["-e", "process.stdout.write(process.argv[1])", "${config.token}"],
            config: { token: { $env: "PATH_TEST_TOKEN" } },
            publish: { seen: "${output}" },
          },
        },
      ],
      output: { seen: "${context.seen}" },
    };

    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.output).toEqual({ seen: VALUE });
  });

  it("masks the resolved value of a composed wrapper, never the variable name", async () => {
    // The ordering this ticket exists for: masking is by value (§8.3), so the masker must collect
    // what `$env` resolved to. Collecting first would scrub the string "PATH_TEST_TOKEN" and let the
    // credential itself through to disk.
    vi.stubEnv("PATH_TEST_TOKEN", VALUE);
    const observer = fakeObserver();
    const file = envEchoFile({ token: { $secret: { $env: "PATH_TEST_TOKEN" } } });

    const result = await runWorkflow(stampNames(file), fixturesDir, { observer });

    expect(result.output).toEqual({ seen: VALUE }); // the worker got the real value
    const persisted = JSON.stringify(observer.all());
    expect(persisted).not.toContain(VALUE);
    expect(persisted).toContain("[secret:token]");
  });

  it("warns about a short env-sourced secret, which resolution is what makes visible", async () => {
    vi.stubEnv("PATH_TEST_TOKEN", "ab");
    const warn = vi.fn();

    await runWorkflow(stampNames(envEchoFile({ pin: { $secret: { $env: "PATH_TEST_TOKEN" } } }, "config.pin")), fixturesDir, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pin/));
  });

  it("fails the run before its first step, naming every unset variable in one failure", async () => {
    vi.stubEnv("PATH_TEST_MISSING_A", undefined);
    vi.stubEnv("PATH_TEST_MISSING_B", undefined);
    const observer = fakeObserver();
    const file = envEchoFile({ token: { $env: "PATH_TEST_MISSING_A" }, other: { $env: "PATH_TEST_MISSING_B" } });

    const result = await runWorkflow(stampNames(file), fixturesDir, { observer });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("PATH_TEST_MISSING_A");
    expect(result.error).toContain("PATH_TEST_MISSING_B");
    // Recorded as a run, not swallowed: a caller watching this run has one to watch, and it ends
    // failed without any step having run.
    expect(observer["run-started"]).toHaveBeenCalledTimes(1);
    expect(observer["step-started"]).not.toHaveBeenCalled();
    expect(observer["run-finished"]).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("still cancels a run whose signal was already aborted, unset variables notwithstanding", async () => {
    // Spec §5.6: a signal already aborted when the run is launched cancels it before its first step.
    // A config failure the operator has already walked away from does not turn that into a failure.
    vi.stubEnv("PATH_TEST_MISSING_A", undefined);
    const controller = new AbortController();
    controller.abort();

    const file = envEchoFile({ token: { $env: "PATH_TEST_MISSING_A" } });
    const result = await runWorkflow(stampNames(file), fixturesDir, { signal: controller.signal });

    expect(result.status).toBe("cancelled");
  });

  it("counts an empty variable as set rather than failing the run", async () => {
    vi.stubEnv("PATH_TEST_TOKEN", "");
    const result = await runWorkflow(stampNames(envEchoFile({ token: { $env: "PATH_TEST_TOKEN" } })), fixturesDir);

    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ seen: "" });
  });

  it("fails on a variable a nested file declares even where the parent's config shadows it", async () => {
    // The accepted cost of the whole-tree sweep, pinned so it stays a decision: the child's own
    // `token` can never be read — the parent's effective config shadows it at the file boundary —
    // and the run still refuses to start. A run that starts and dies at step 14 is worse.
    vi.stubEnv("PATH_TEST_MISSING_A", undefined);
    const child: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "child",
      worker: { type: "engine" },
      config: { token: { $env: "PATH_TEST_MISSING_A" } },
      body: [{ type: "binary", id: "noop", name: "noop", command: "node", args: ["-e", "process.stdout.write('ok')"] }],
    };
    const childPath = join(fixturesDir, "env-child.workflow.json");
    const parent: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "parent",
      worker: { type: "engine" },
      config: { token: "parent-wins" },
      body: [{ type: "workflow", id: "sub", name: "sub", ref: "env-child.workflow.json", input: {} }],
    };

    const result = await runWorkflow(stampNames(parent), fixturesDir, { files: new Map([[childPath, child]]) });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("PATH_TEST_MISSING_A");
  });
});

describe("runWorkflow — input maps (ticket #17)", () => {
  it("builds the step's input object from an interpolated map, preserving real types and literals", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "input-map",
      worker: { type: "engine" },
      config: { max: 3 },
      body: [
        {
          type: "binary",
          id: "reflect", name: "reflect",
          command: "node",
          args: ["-e", echoStdinScript()],
          input: { greeting: "${context.name}", count: "${config.max}", literal: "constant" },
          publish: { reflected: "${output}" },
        },
      ],
      output: { reflected: "${context.reflected}" },
    };

    const result = await runWorkflow(stampNames(file), fixturesDir, { input: { name: "Bob" } });
    expect(result.status).toBe("succeeded");
    expect(JSON.parse((result.output as { reflected: string }).reflected)).toEqual({
      greeting: "Bob",
      count: 3,
      literal: "constant",
    });
  });

  it("fails the run with a clear message on an unresolvable interpolation path", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "bad-path",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "reflect", name: "reflect",
          command: "node",
          args: ["-e", echoStdinScript()],
          input: { x: "${context.missing}" },
        },
      ],
    };
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/missing/);
  });
});

describe("runWorkflow — publish (ticket #17)", () => {
  it("lands atomically on step success, visible to the very next node", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "publish-then-read",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "first", name: "first",
          command: "node",
          args: ["-e", "process.stdout.write('hi')"],
          publish: { greeting: "${output}" },
        },
        {
          type: "binary",
          id: "second", name: "second",
          command: "node",
          args: ["-e", echoStdinScript()],
          input: "${context.greeting}",
        },
      ],
    };
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("succeeded");
  });

  it("publishes nothing when the step fails", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "failed-publish",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "boom", name: "boom",
          command: "node",
          args: ["-e", "process.exit(3)"],
          // If publish were (wrongly) evaluated on failure, this would throw an interpolation
          // error of its own (output is never a string with an "x" key here) — instead the
          // reported error must be the exit-code failure, proving publish was never attempted.
          publish: { bogus: "${output.x}" },
        },
      ],
    };
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exited with code 3/);
  });
});

describe("runWorkflow — parse: json (ticket #17)", () => {
  it("yields a structured output object addressable by downstream dot-paths, preserving type", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "parse-json",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "produce", name: "produce",
          command: "node",
          args: ["-e", "process.stdout.write(JSON.stringify({value: 42}))"],
          parse: "json",
          publish: { data: "${output}" },
        },
        {
          type: "binary",
          id: "consume", name: "consume",
          command: "node",
          args: ["-e", echoStdinScript()],
          input: { seen: "${context.data.value}" },
        },
      ],
      output: {},
    };
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("succeeded");
  });

  it("fails the step on unparseable output", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "parse-json-bad",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "produce", name: "produce",
          command: "node",
          args: ["-e", "process.stdout.write('not json')"],
          parse: "json",
        },
      ],
    };
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/parse/i);
  });
});

describe("runWorkflow — workflow output map (ticket #17)", () => {
  it("evaluates the top-level output map at successful run end", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "output-map",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "step", name: "step",
          command: "node",
          args: ["-e", "process.stdout.write('done')"],
          publish: { result: "${output}" },
        },
      ],
      output: { final: "${context.result}", literal: "x" },
    };
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ final: "done", literal: "x" });
  });

  it("defaults to an empty object when no output map is declared", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "no-output-map",
      worker: { type: "engine" },
      body: [{ type: "binary", id: "step", name: "step", command: "node", args: ["-e", "process.exit(0)"] }],
    };
    const result = await runWorkflow(stampNames(file), fixturesDir);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({});
  });
});

describe("runWorkflow — nested workflow steps (ticket #22)", () => {
  const parentPath = join(fixturesDir, "parent.workflow.json");
  const childPath = join(fixturesDir, "nested-child.workflow.json");

  // Build the in-memory { absPath -> file } map runWorkflow resolves `ref`s against — the same
  // shape loadWorkflowTree produces, so these unit tests never touch disk.
  function tree(parent: WorkflowFile, child: WorkflowFile): Map<string, WorkflowFile> {
    return new Map([
      [parentPath, parent],
      [childPath, child],
    ]);
  }

  const noopStep = { type: "binary" as const, id: "noop", name: "noop", command: "node", args: ["-e", "process.exit(0)"] };

  it("the child sees only its input-seeded context, and the parent receives exactly the child's output map", async () => {
    const parent: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "parent",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "seed-parent", name: "seed-parent",
          command: "node",
          args: ["-e", "process.stdout.write('parent-only')"],
          publish: { parentKey: "${output}" },
        },
        {
          type: "workflow",
          id: "call-child", name: "call-child",
          ref: "./nested-child.workflow.json",
          input: { seed: "from-parent" },
          publish: { childOut: "${output}" },
        },
      ],
      output: { childOut: "${context.childOut}" },
    };
    const child: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "child",
      worker: { type: "engine" },
      body: [noopStep],
      output: { echoedSeed: "${context.seed}" },
    };

    const result = await runWorkflow(stampNames(parent), fixturesDir, { files: tree(parent, child) });
    expect(result.status).toBe("succeeded");
    // The step's output object *is* the child's `output` map — nothing more, nothing less.
    expect(result.output).toEqual({ childOut: { echoedSeed: "from-parent" } });
  });

  it("fails the child when it reads a parent context key — proving the parent's context never crosses", async () => {
    const parent: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "parent",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "seed-parent", name: "seed-parent",
          command: "node",
          args: ["-e", "process.stdout.write('secret')"],
          publish: { parentKey: "${output}" },
        },
        { type: "workflow", id: "call-child", name: "call-child", ref: "./nested-child.workflow.json", input: { seed: "x" } },
      ],
    };
    const child: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "child",
      worker: { type: "engine" },
      body: [noopStep],
      output: { leaked: "${context.parentKey}" }, // parentKey is a *parent* context key
    };

    const result = await runWorkflow(stampNames(parent), fixturesDir, { files: tree(parent, child) });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/parentKey/);
  });

  it("a child publish never reaches the parent context", async () => {
    const parent: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "parent",
      worker: { type: "engine" },
      body: [
        { type: "workflow", id: "call-child", name: "call-child", ref: "./nested-child.workflow.json", input: {} },
        // If the child's publish had leaked into the parent context, `childInternal` would resolve;
        // it must not, so this second step's input interpolation fails the parent run instead.
        {
          type: "binary",
          id: "read-leak", name: "read-leak",
          command: "node",
          args: ["-e", echoStdinScript()],
          input: "${context.childInternal}",
        },
      ],
    };
    const child: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "child",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "produce", name: "produce",
          command: "node",
          args: ["-e", "process.stdout.write('v')"],
          publish: { childInternal: "${output}" }, // written to the *child's* context only
        },
      ],
    };

    const result = await runWorkflow(stampNames(parent), fixturesDir, { files: tree(parent, child) });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/childInternal/);
  });

  it("config inherits across the file boundary per key, but the parent's worker default does not", async () => {
    const parent: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "parent",
      // A non-engine parent default worker: if it (wrongly) crossed the boundary, the child's
      // engine-run binary step would still execute, but the child's own worker is what governs —
      // asserted structurally via the output map, and the run simply succeeds on the engine.
      worker: { type: "llm", model: "parent-model" },
      config: { shared: "from-parent" },
      body: [
        {
          type: "workflow",
          id: "call-child", name: "call-child",
          ref: "./nested-child.workflow.json",
          input: {},
          publish: { childOut: "${output}" },
        },
      ],
      output: { childOut: "${context.childOut}" },
    };
    const child: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "child",
      worker: { type: "engine" }, // the child's own worker runs its binary step
      config: { shared: "child-default", childOnly: "kept" },
      body: [noopStep],
      // shared: parent's effective config shadows the child's default; childOnly: child's own kept.
      output: { shared: "${config.shared}", childOnly: "${config.childOnly}" },
    };

    const result = await runWorkflow(stampNames(parent), fixturesDir, { files: tree(parent, child) });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ childOut: { shared: "from-parent", childOnly: "kept" } });
  });

  it("fails clearly when a workflow step's input does not resolve to a JSON object", async () => {
    const parent: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "parent",
      worker: { type: "engine" },
      body: [{ type: "workflow", id: "call-child", name: "call-child", ref: "./nested-child.workflow.json", input: "not-an-object" }],
    };
    const child: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "child",
      worker: { type: "engine" },
      body: [noopStep],
    };

    const result = await runWorkflow(stampNames(parent), fixturesDir, { files: tree(parent, child) });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/JSON object/);
  });
});

describe("runWorkflow — RunObserver hooks (ticket #18 seam)", () => {
  it("reports runStarted, stepStarted/stepFinished per step, and runFinished on success", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "observed",
      worker: { type: "engine" },
      body: [{ type: "binary", id: "greet", name: "greet", command: "node", args: ["-e", "process.stdout.write('hi')"] }],
    };

    const result = await runWorkflow(stampNames(file), fixturesDir, { input: { seed: 1 }, observer });

    expect(result.status).toBe("succeeded");
    expect(observer["run-started"]).toHaveBeenCalledTimes(1);
    const { runId } = observer["run-started"].mock.calls[0]![0];
    expect(observer["run-started"]).toHaveBeenCalledWith({
      runId,
      rootRunId: runId, // the root run is its own root
      parentRunId: null,
      nodeId: null,
      nodeName: null,
      input: { seed: 1 },
      worker: { type: "engine" },
      // Source-workflow identity is stamped on the root run-started (#202): the file's own GUID + name.
      // No `workflowPath` here — this caller passed no `sourceWorkflowPath`.
      workflowId: "wf-id",
      workflowName: "observed",
    });

    expect(observer["step-started"]).toHaveBeenCalledTimes(1);
    const stepCall = observer["step-started"].mock.calls[0]![0];
    expect(stepCall.parentRunId).toBe(runId);
    expect(stepCall.rootRunId).toBe(runId);
    expect(stepCall.nodeId).toBe("greet");
    expect(stepCall.stepType).toBe("binary");
    expect(stepCall.worker).toEqual({ type: "engine" });
    expect(stepCall.runId).not.toBe(runId); // the step run is distinct from the root run

    expect(observer["step-stderr"]).toHaveBeenCalledWith({ runId: stepCall.runId, rootRunId: runId, stderr: "" });
    expect(observer["step-finished"]).toHaveBeenCalledWith({
      runId: stepCall.runId,
      rootRunId: runId,
      status: "succeeded",
      output: "hi",
    });
    expect(observer["run-finished"]).toHaveBeenCalledWith({ runId, rootRunId: runId, status: "succeeded", output: {} });
  });

  it("reports stepFinished failed and runFinished failed on a non-zero exit, without a stepFinished-succeeded call", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "observed-fail",
      worker: { type: "engine" },
      body: [{ type: "binary", id: "boom", name: "boom", command: "node", args: ["-e", "process.exit(2)"] }],
    };

    const result = await runWorkflow(stampNames(file), fixturesDir, { observer });

    expect(result.status).toBe("failed");
    const { runId } = observer["run-started"].mock.calls[0]![0];
    const stepCall = observer["step-started"].mock.calls[0]![0];
    expect(observer["step-finished"]).toHaveBeenCalledWith({
      runId: stepCall.runId,
      rootRunId: runId,
      status: "failed",
      error: expect.stringMatching(/exited with code 2/),
    });
    expect(observer["run-finished"]).toHaveBeenCalledWith({
      runId,
      rootRunId: runId,
      status: "failed",
      error: expect.stringMatching(/exited with code 2/),
    });
  });

  it("reports runFinished failed even when the run fails before any step starts", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "observed-unsupported",
      worker: { type: "engine" },
      body: [{ type: "telepathy", id: "guess" } as unknown as WorkflowFile["body"][number]],
    };

    await runWorkflow(stampNames(file), fixturesDir, { observer });

    expect(observer["step-started"]).not.toHaveBeenCalled();
    const { runId } = observer["run-started"].mock.calls[0]![0];
    expect(observer["run-finished"]).toHaveBeenCalledWith({
      runId,
      rootRunId: runId,
      status: "failed",
      error: expect.stringMatching(/not supported by this engine/),
    });
  });

  it("reports contextChanged with the root run's id after a publish lands", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "observed-publish",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "step", name: "step",
          command: "node",
          args: ["-e", "process.stdout.write('v')"],
          publish: { seen: "${output}" },
        },
      ],
    };

    await runWorkflow(stampNames(file), fixturesDir, { observer });

    const { runId } = observer["run-started"].mock.calls[0]![0];
    expect(observer["context-changed"]).toHaveBeenCalledWith({ runId, rootRunId: runId, context: { seen: "v" } });
  });
});

/**
 * What a prompt step does with a worker is pinned at the node seam (`run-node.test.ts`). What is
 * left here is the part only a whole run has: the processor cap is one semaphore for the entire run
 * *tree*, and its default comes from `RunOptions` — neither is visible from a single node.
 */
describe("runWorkflow — the engine-wide processor cap (ticket #25, spec §5.5)", () => {
  /** A stand-in LLM worker that tracks how many processors were live at once. */
  function fakeLlmWorker(
    respond: (request: PromptRequest) => Promise<PromptResult> | PromptResult = () => ({
      status: "succeeded",
      output: "ok",
      usage: { input_tokens: 1, output_tokens: 2 },
      estimatedCostUsd: 0.001,
    }),
  ) {
    const requests: PromptRequest[] = [];
    let live = 0;
    let peakLive = 0;
    const worker: LlmWorker = {
      async runPrompt(request) {
        requests.push(request);
        live += 1;
        peakLive = Math.max(peakLive, live);
        try {
          return await respond(request);
        } finally {
          live -= 1;
        }
      },
    };
    return {
      worker,
      requests,
      get peakLive() {
        return peakLive;
      },
    };
  }

  const llmFile = (body: WorkflowFile["body"], rest: Partial<WorkflowFile> = {}): WorkflowFile => ({
    format: "path/workflow@2",
    id: "wf-id",
    name: "prompt-run",
    worker: { type: "llm", model: "claude-sonnet-5" },
    body,
    ...rest,
  });

  it("spans the cap across nested workflow-runs, not just one file's branches (spec §5.5)", async () => {
    const child: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "child",
      worker: { type: "llm", model: "claude-sonnet-5" },
      body: [{ type: "prompt", id: "child-ask", name: "child-ask", prompt: "Child question." }],
      output: { answer: "${context.answer}" },
    };
    (child.body[0] as { publish?: unknown }).publish = { answer: "${output}" };

    const childPath = join(fixturesDir, "llm-child.workflow.json");
    const file = llmFile([
      {
        type: "parallel",
        id: "fanout", name: "fanout",
        join: "collect",
        branches: [
          { type: "sequence", id: "direct", name: "direct", body: [{ type: "prompt", id: "ask", name: "ask", prompt: "Parent question." }] },
          { type: "sequence", id: "nested", name: "nested", body: [{ type: "workflow", id: "sub", name: "sub", ref: "llm-child.workflow.json", input: {} }] },
        ],
      },
    ]);

    const llm = fakeLlmWorker(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { status: "succeeded", output: "ok", usage: null, estimatedCostUsd: null };
    });
    const result = await runWorkflow(stampNames(file), fixturesDir, {
      llmWorker: llm.worker,
      llmConcurrency: 1,
      files: new Map([[childPath, child]]),
    });

    expect(result.status).toBe("succeeded");
    expect(llm.requests).toHaveLength(2);
    expect(llm.peakLive).toBe(1); // the nested run's processor queues behind the parent's
  });

  it("defaults the cap to 4 concurrent processors when the operator sets none", async () => {
    const llm = fakeLlmWorker(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { status: "succeeded", output: "ok", usage: null, estimatedCostUsd: null };
    });
    const branch = (id: string) => ({
      type: "sequence" as const,
      id,
      name: id,
      body: [{ type: "prompt" as const, id: `ask-${id}`, name: `ask-${id}`, prompt: `Question ${id}.` }],
    });
    const file = llmFile([
      {
        type: "parallel",
        id: "fanout", name: "fanout",
        join: "collect",
        branches: [branch("a"), branch("b"), branch("c"), branch("d"), branch("e"), branch("f")],
      },
    ]);

    const result = await runWorkflow(stampNames(file), fixturesDir, { llmWorker: llm.worker });

    expect(result.status).toBe("succeeded");
    expect(llm.peakLive).toBe(DEFAULT_LLM_CONCURRENCY);
  });

});

describe("runWorkflow — external abort of a root run (ticket #52)", () => {
  // A step that outlives any test: the operator's abort is what ends it, never its own completion.
  const sleeperNode = (id: string) => ({
    type: "binary" as const,
    id,
    name: id,
    command: "node",
    args: ["-e", "setTimeout(()=>process.stdout.write('done'),5000)"],
    publish: { slow: "${output}" },
  });

  /**
   * Aborts once `nodeId`'s run has started — from a timer, not inline: the engine spawns the child
   * (and registers its abort listener) synchronously after awaiting `stepStarted`, so a timer is what
   * puts the abort *after* the step is genuinely in flight rather than before it ever runs.
   */
  function abortWhenStarted(observer: FakeObserver, nodeId: string): AbortController {
    const controller = new AbortController();
    observer["step-started"].mockImplementation((info: { nodeId: string }) => {
      if (info.nodeId === nodeId) setTimeout(() => controller.abort(), 0);
    });
    return controller;
  }

  it("ends the root run cancelled, narrating the killed binary step as an operator cancellation", async () => {
    const observer = fakeObserver();
    const controller = abortWhenStarted(observer, "sleeper");
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "operator-cancel",
      worker: { type: "engine" },
      body: [
        sleeperNode("sleeper"),
        { type: "binary", id: "never", name: "never", command: "node", args: ["-e", "process.stdout.write('nope')"] },
      ],
    };

    const result = await runWorkflow(stampNames(file), fixturesDir, { observer, signal: controller.signal });

    // The root run ends cancelled — not failed (the workflow did not break), and not left running.
    expect(result.status).toBe("cancelled");
    const root = observer["run-started"].mock.calls[0]![0];
    expect(observer["run-finished"]).toHaveBeenCalledWith({ runId: root.runId, rootRunId: root.runId, status: "cancelled" });

    // The killed step's cancellation names its cause: the operator, with no cause run behind it.
    const sleeper = observer["step-started"].mock.calls.map((c) => c[0]).find((s) => s.nodeId === "sleeper")!;
    expect(observer["run-cancelled"]).toHaveBeenCalledWith({
      runId: sleeper.runId,
      rootRunId: root.runId,
      nodeId: "sleeper",
      nodeName: "sleeper",
      cause: "operator",
      causeRunId: null,
    });
    expect(observer["step-finished"]).toHaveBeenCalledWith({ runId: sleeper.runId, rootRunId: root.runId, status: "cancelled" });

    // Nothing downstream of the abort runs, and the cancelled step's publish never lands (#24).
    expect(observer["step-started"].mock.calls.map((c) => c[0].nodeId)).toEqual(["sleeper"]);
    expect(observer["context-changed"]).not.toHaveBeenCalled();
  });

  it("cancels a prompt step in flight through the llmWorker seam", async () => {
    const observer = fakeObserver();
    const controller = abortWhenStarted(observer, "ask");
    // Holds the processor open until the abort reaches it — what the Agent SDK worker does for real.
    const llmWorker: LlmWorker = {
      async runPrompt(request: PromptRequest): Promise<PromptResult> {
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
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "operator-cancel-prompt",
      worker: { type: "llm", model: "claude-sonnet-5" },
      body: [{ type: "prompt", id: "ask", name: "ask", prompt: "Hi.", publish: { answer: "${output}" } }],
    };

    const result = await runWorkflow(stampNames(file), fixturesDir, { observer, llmWorker, signal: controller.signal });

    expect(result.status).toBe("cancelled");
    const root = observer["run-started"].mock.calls[0]![0];
    const ask = observer["step-started"].mock.calls.map((c) => c[0]).find((s) => s.nodeId === "ask")!;
    expect(observer["run-cancelled"]).toHaveBeenCalledWith({
      runId: ask.runId,
      rootRunId: root.runId,
      nodeId: "ask",
      nodeName: "ask",
      cause: "operator",
      causeRunId: null,
    });
    expect(observer["run-finished"]).toHaveBeenCalledWith({ runId: root.runId, rootRunId: root.runId, status: "cancelled" });
    expect(observer["context-changed"]).not.toHaveBeenCalled();
  });

  it("runs no step at all when the signal is already aborted at launch", async () => {
    const observer = fakeObserver();
    const controller = new AbortController();
    controller.abort();
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "pre-aborted",
      worker: { type: "engine" },
      body: [{ type: "binary", id: "greet", name: "greet", command: "node", args: ["-e", "process.stdout.write('hi')"] }],
    };

    const result = await runWorkflow(stampNames(file), fixturesDir, { observer, signal: controller.signal });

    expect(result.status).toBe("cancelled");
    // The run row still exists and lands cancelled: an already-aborted signal is not a special case.
    expect(observer["run-started"]).toHaveBeenCalledTimes(1);
    const root = observer["run-started"].mock.calls[0]![0];
    expect(observer["run-finished"]).toHaveBeenCalledWith({ runId: root.runId, rootRunId: root.runId, status: "cancelled" });
    // No step ran, so there is no killed run to narrate.
    expect(observer["step-started"]).not.toHaveBeenCalled();
    expect(observer["run-cancelled"]).not.toHaveBeenCalled();
  });

  it("cancels a nested workflow-run's step too, ending the whole tree cancelled", async () => {
    const observer = fakeObserver();
    const controller = abortWhenStarted(observer, "sleeper");
    const childPath = join(fixturesDir, "nested-child.workflow.json");
    const child: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "child",
      worker: { type: "engine" },
      body: [sleeperNode("sleeper")],
    };
    const parent: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "parent",
      worker: { type: "engine" },
      body: [{ type: "workflow", id: "call-child", name: "call-child", ref: "nested-child.workflow.json", input: {} }],
    };

    const result = await runWorkflow(stampNames(parent), fixturesDir, {
      observer,
      signal: controller.signal,
      files: new Map([[childPath, child]]),
    });

    expect(result.status).toBe("cancelled");
    // Both workflow-runs end cancelled — the root's own row included.
    const [root, nested] = observer["run-started"].mock.calls.map((c) => c[0]) as [
      (typeof observer)["run-started"]["mock"]["calls"][number][0],
      (typeof observer)["run-started"]["mock"]["calls"][number][0],
    ];
    expect(observer["run-finished"]).toHaveBeenCalledWith({ runId: nested.runId, rootRunId: root.runId, status: "cancelled" });
    expect(observer["run-finished"]).toHaveBeenCalledWith({ runId: root.runId, rootRunId: root.runId, status: "cancelled" });
    expect(observer["run-cancelled"]).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "sleeper", nodeName: "sleeper", cause: "operator", causeRunId: null }));
  });

  it("still calls a cancellation sibling-failed when the failing branch encloses a nested parallel", async () => {
    // The cause must be read when the kill happens, not at block entry: the inner block starts before
    // the outer sibling fails, so a cause snapshotted at entry would be null — and null means operator.
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "nested-parallel-cause",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "outer", name: "outer",
          join: "collect",
          branches: [
            {
              type: "sequence", id: "nested", name: "nested",
              body: [
                {
                  type: "parallel",
                  id: "inner", name: "inner",
                  join: "collect",
                  branches: [{ type: "sequence", id: "deep-branch", name: "deep-branch", body: [sleeperNode("deep")] }],
                },
              ],
            },
            { type: "sequence", id: "boom", name: "boom", body: [{ type: "binary", id: "kaboom", name: "kaboom", command: "node", args: ["-e", "process.exit(1)"] }] },
          ],
        },
      ],
    };

    const result = await runWorkflow(stampNames(file), fixturesDir, { observer });

    expect(result.status).toBe("failed");
    const kaboom = observer["step-started"].mock.calls.map((c) => c[0]).find((s) => s.nodeId === "kaboom")!;
    expect(observer["run-cancelled"]).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "deep", nodeName: "deep", cause: "sibling-failed", causeRunId: kaboom.runId }),
    );
  });

  it("cancels the in-flight branches of a parallel block as operator cancellations", async () => {
    const observer = fakeObserver();
    const controller = abortWhenStarted(observer, "sleep-a");
    const file: WorkflowFile = {
      format: "path/workflow@2",
      id: "wf-id",
      name: "operator-cancel-parallel",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "fanout", name: "fanout",
          join: "collect",
          branches: [
            { type: "sequence", id: "a", name: "a", body: [sleeperNode("sleep-a")] },
            { type: "sequence", id: "b", name: "b", body: [sleeperNode("sleep-b")] },
          ],
        },
      ],
    };

    const result = await runWorkflow(stampNames(file), fixturesDir, { observer, signal: controller.signal });

    expect(result.status).toBe("cancelled");
    // No sibling failed, so neither branch's cancellation points at a cause run.
    const causes = observer["run-cancelled"].mock.calls.map((c) => c[0]);
    expect(causes.length).toBeGreaterThan(0);
    for (const cancelled of causes) {
      expect(cancelled).toMatchObject({ cause: "operator", causeRunId: null });
    }
    expect(observer["join-applied"]).not.toHaveBeenCalled();
  });
});
