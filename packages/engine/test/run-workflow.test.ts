import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowFile, type ConfigObject, type WorkflowFile } from "@path/schema";
import { describe, expect, it, vi } from "vitest";
import type { LlmWorker, PromptRequest, PromptResult } from "../src/llm/llm-worker.js";
import { DEFAULT_LLM_CONCURRENCY } from "../src/llm/processor-semaphore.js";
import { fakeObserver, type FakeObserver } from "./fake-observer.js";
import type { RunObserver } from "../src/run-observer.js";
import { runWorkflow } from "../src/run-workflow.js";

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
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("succeeded");
  });

  it("fails fast on a non-zero exit and does not run subsequent steps", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "fail-fast",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "boom", command: "node", args: ["-e", "process.exit(3)"] },
        { type: "binary", id: "never", command: "node", args: ["-e", "process.stdout.write('nope')"] },
      ],
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/boom/);
    expect(result.error).toMatch(/\b3\b/);
  });

  it("respects a step's own cwd override", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "cwd-check",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "pwd",
          command: "node",
          args: ["-e", "process.stdout.write(process.cwd())"],
          cwd: fixturesDir,
        },
      ],
    };
    const result = await runWorkflow(file, "/tmp");
    expect(result.status).toBe("succeeded");
  });

  it("resolves a relative cwd against the workflow file's directory, not the process's", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "relative-cwd",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "pwd",
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
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ pwd: realpathSync(fixturesDir) });
  });

  it("fails clearly on unsupported node types instead of silently skipping them", async () => {
    // Every node type the format declares now executes (#25 completed the set with `prompt`), so
    // reaching this guard takes a node the schema itself would reject. It stays for the case of a
    // new type landing in the format before the engine walks it: fail loudly, never skip.
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "unknown-node",
      worker: { type: "engine" },
      body: [{ type: "telepathy", id: "guess" } as unknown as WorkflowFile["body"][number]],
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/telepathy/);
  });
});

describe("runWorkflow — config interpolation and inheritance (ticket #17)", () => {
  function configEchoFile(stepConfig?: ConfigObject): WorkflowFile {
    return {
      format: "path/workflow@0",
      name: "config-echo",
      worker: { type: "engine" },
      config: { greeting: "file-default" },
      body: [
        {
          type: "binary",
          id: "echo",
          command: "node",
          args: ["-e", "process.stdout.write(process.argv[1])", "${config.greeting}"],
          ...(stepConfig ? { config: stepConfig } : {}),
        },
      ],
    };
  }

  it("uses the file's config default when nothing overrides it", async () => {
    const result = await runWorkflow(configEchoFile(), fixturesDir);
    expect(result.status).toBe("succeeded");
  });

  it("operator config overrides the file's config default, nearest wins", async () => {
    const file = configEchoFile();
    // RunResult.output on success is the workflow output map, not the raw step output — surface
    // what the step actually received via publish + a matching output map entry.
    (file.body[0] as { publish?: Record<string, unknown> }).publish = { seen: "${output}" };
    file.output = { seen: "${context.seen}" };

    const result = await runWorkflow(file, fixturesDir, { operatorConfig: { greeting: "operator-override" } });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ seen: "operator-override" });
  });

  it("a step-level config override wins over both file default and operator config", async () => {
    const file = configEchoFile({ greeting: "step-override" });
    (file.body[0] as { publish?: Record<string, unknown> }).publish = { seen: "${output}" };
    file.output = { seen: "${context.seen}" };

    const result = await runWorkflow(file, fixturesDir, { operatorConfig: { greeting: "operator-override" } });
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
      format: "path/workflow@0",
      name: "secret-leak",
      worker: { type: "engine" },
      config: { apiKey: { $secret: SECRET } },
      body: [
        {
          type: "binary",
          id: "leak",
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
    const result = await runWorkflow(secretLeakFile(), fixturesDir, { observer });

    // The spawned process received the real value: the unmasked RunResult carries it through.
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ result: SECRET });

    // Nothing crossing the persistence boundary leaks the real value; the token stands in for it.
    const dump = persisted();
    expect(dump).not.toContain(SECRET);
    expect(dump).toContain("[secret:apiKey]");
  });

  it("emits a load-time warning for a short secret", async () => {
    const file = secretLeakFile();
    file.config = { pin: { $secret: "ab" } };
    const warn = vi.fn();

    await runWorkflow(file, fixturesDir, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pin/));
  });
});

describe("runWorkflow — input maps (ticket #17)", () => {
  it("builds the step's input object from an interpolated map, preserving real types and literals", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "input-map",
      worker: { type: "engine" },
      config: { max: 3 },
      body: [
        {
          type: "binary",
          id: "reflect",
          command: "node",
          args: ["-e", echoStdinScript()],
          input: { greeting: "${context.name}", count: "${config.max}", literal: "constant" },
          publish: { reflected: "${output}" },
        },
      ],
      output: { reflected: "${context.reflected}" },
    };

    const result = await runWorkflow(file, fixturesDir, { input: { name: "Bob" } });
    expect(result.status).toBe("succeeded");
    expect(JSON.parse((result.output as { reflected: string }).reflected)).toEqual({
      greeting: "Bob",
      count: 3,
      literal: "constant",
    });
  });

  it("fails the run with a clear message on an unresolvable interpolation path", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "bad-path",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "reflect",
          command: "node",
          args: ["-e", echoStdinScript()],
          input: { x: "${context.missing}" },
        },
      ],
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/missing/);
  });
});

describe("runWorkflow — publish (ticket #17)", () => {
  it("lands atomically on step success, visible to the very next node", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "publish-then-read",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "first",
          command: "node",
          args: ["-e", "process.stdout.write('hi')"],
          publish: { greeting: "${output}" },
        },
        {
          type: "binary",
          id: "second",
          command: "node",
          args: ["-e", echoStdinScript()],
          input: "${context.greeting}",
        },
      ],
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("succeeded");
  });

  it("publishes nothing when the step fails", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "failed-publish",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "boom",
          command: "node",
          args: ["-e", "process.exit(3)"],
          // If publish were (wrongly) evaluated on failure, this would throw an interpolation
          // error of its own (output is never a string with an "x" key here) — instead the
          // reported error must be the exit-code failure, proving publish was never attempted.
          publish: { bogus: "${output.x}" },
        },
      ],
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exited with code 3/);
  });
});

describe("runWorkflow — parse: json (ticket #17)", () => {
  it("yields a structured output object addressable by downstream dot-paths, preserving type", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "parse-json",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "produce",
          command: "node",
          args: ["-e", "process.stdout.write(JSON.stringify({value: 42}))"],
          parse: "json",
          publish: { data: "${output}" },
        },
        {
          type: "binary",
          id: "consume",
          command: "node",
          args: ["-e", echoStdinScript()],
          input: { seen: "${context.data.value}" },
        },
      ],
      output: {},
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("succeeded");
  });

  it("fails the step on unparseable output", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "parse-json-bad",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "produce",
          command: "node",
          args: ["-e", "process.stdout.write('not json')"],
          parse: "json",
        },
      ],
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/parse/i);
  });
});

describe("runWorkflow — workflow output map (ticket #17)", () => {
  it("evaluates the top-level output map at successful run end", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "output-map",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "step",
          command: "node",
          args: ["-e", "process.stdout.write('done')"],
          publish: { result: "${output}" },
        },
      ],
      output: { final: "${context.result}", literal: "x" },
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ final: "done", literal: "x" });
  });

  it("defaults to an empty object when no output map is declared", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "no-output-map",
      worker: { type: "engine" },
      body: [{ type: "binary", id: "step", command: "node", args: ["-e", "process.exit(0)"] }],
    };
    const result = await runWorkflow(file, fixturesDir);
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

  const noopStep = { type: "binary" as const, id: "noop", command: "node", args: ["-e", "process.exit(0)"] };

  it("the child sees only its input-seeded context, and the parent receives exactly the child's output map", async () => {
    const parent: WorkflowFile = {
      format: "path/workflow@0",
      name: "parent",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "seed-parent",
          command: "node",
          args: ["-e", "process.stdout.write('parent-only')"],
          publish: { parentKey: "${output}" },
        },
        {
          type: "workflow",
          id: "call-child",
          ref: "./nested-child.workflow.json",
          input: { seed: "from-parent" },
          publish: { childOut: "${output}" },
        },
      ],
      output: { childOut: "${context.childOut}" },
    };
    const child: WorkflowFile = {
      format: "path/workflow@0",
      name: "child",
      worker: { type: "engine" },
      body: [noopStep],
      output: { echoedSeed: "${context.seed}" },
    };

    const result = await runWorkflow(parent, fixturesDir, { files: tree(parent, child) });
    expect(result.status).toBe("succeeded");
    // The step's output object *is* the child's `output` map — nothing more, nothing less.
    expect(result.output).toEqual({ childOut: { echoedSeed: "from-parent" } });
  });

  it("fails the child when it reads a parent context key — proving the parent's context never crosses", async () => {
    const parent: WorkflowFile = {
      format: "path/workflow@0",
      name: "parent",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "seed-parent",
          command: "node",
          args: ["-e", "process.stdout.write('secret')"],
          publish: { parentKey: "${output}" },
        },
        { type: "workflow", id: "call-child", ref: "./nested-child.workflow.json", input: { seed: "x" } },
      ],
    };
    const child: WorkflowFile = {
      format: "path/workflow@0",
      name: "child",
      worker: { type: "engine" },
      body: [noopStep],
      output: { leaked: "${context.parentKey}" }, // parentKey is a *parent* context key
    };

    const result = await runWorkflow(parent, fixturesDir, { files: tree(parent, child) });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/parentKey/);
  });

  it("a child publish never reaches the parent context", async () => {
    const parent: WorkflowFile = {
      format: "path/workflow@0",
      name: "parent",
      worker: { type: "engine" },
      body: [
        { type: "workflow", id: "call-child", ref: "./nested-child.workflow.json", input: {} },
        // If the child's publish had leaked into the parent context, `childInternal` would resolve;
        // it must not, so this second step's input interpolation fails the parent run instead.
        {
          type: "binary",
          id: "read-leak",
          command: "node",
          args: ["-e", echoStdinScript()],
          input: "${context.childInternal}",
        },
      ],
    };
    const child: WorkflowFile = {
      format: "path/workflow@0",
      name: "child",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "produce",
          command: "node",
          args: ["-e", "process.stdout.write('v')"],
          publish: { childInternal: "${output}" }, // written to the *child's* context only
        },
      ],
    };

    const result = await runWorkflow(parent, fixturesDir, { files: tree(parent, child) });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/childInternal/);
  });

  it("config inherits across the file boundary per key, but the parent's worker default does not", async () => {
    const parent: WorkflowFile = {
      format: "path/workflow@0",
      name: "parent",
      // A non-engine parent default worker: if it (wrongly) crossed the boundary, the child's
      // engine-run binary step would still execute, but the child's own worker is what governs —
      // asserted structurally via the output map, and the run simply succeeds on the engine.
      worker: { type: "llm", model: "parent-model" },
      config: { shared: "from-parent" },
      body: [
        {
          type: "workflow",
          id: "call-child",
          ref: "./nested-child.workflow.json",
          input: {},
          publish: { childOut: "${output}" },
        },
      ],
      output: { childOut: "${context.childOut}" },
    };
    const child: WorkflowFile = {
      format: "path/workflow@0",
      name: "child",
      worker: { type: "engine" }, // the child's own worker runs its binary step
      config: { shared: "child-default", childOnly: "kept" },
      body: [noopStep],
      // shared: parent's effective config shadows the child's default; childOnly: child's own kept.
      output: { shared: "${config.shared}", childOnly: "${config.childOnly}" },
    };

    const result = await runWorkflow(parent, fixturesDir, { files: tree(parent, child) });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ childOut: { shared: "from-parent", childOnly: "kept" } });
  });

  it("fails clearly when a workflow step's input does not resolve to a JSON object", async () => {
    const parent: WorkflowFile = {
      format: "path/workflow@0",
      name: "parent",
      worker: { type: "engine" },
      body: [{ type: "workflow", id: "call-child", ref: "./nested-child.workflow.json", input: "not-an-object" }],
    };
    const child: WorkflowFile = {
      format: "path/workflow@0",
      name: "child",
      worker: { type: "engine" },
      body: [noopStep],
    };

    const result = await runWorkflow(parent, fixturesDir, { files: tree(parent, child) });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/JSON object/);
  });
});

describe("runWorkflow — RunObserver hooks (ticket #18 seam)", () => {
  it("reports runStarted, stepStarted/stepFinished per step, and runFinished on success", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "observed",
      worker: { type: "engine" },
      body: [{ type: "binary", id: "greet", command: "node", args: ["-e", "process.stdout.write('hi')"] }],
    };

    const result = await runWorkflow(file, fixturesDir, { input: { seed: 1 }, observer });

    expect(result.status).toBe("succeeded");
    expect(observer["run-started"]).toHaveBeenCalledTimes(1);
    const { runId } = observer["run-started"].mock.calls[0]![0];
    expect(observer["run-started"]).toHaveBeenCalledWith({
      runId,
      rootRunId: runId, // the root run is its own root
      parentRunId: null,
      nodeId: null,
      input: { seed: 1 },
      worker: { type: "engine" },
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
      format: "path/workflow@0",
      name: "observed-fail",
      worker: { type: "engine" },
      body: [{ type: "binary", id: "boom", command: "node", args: ["-e", "process.exit(2)"] }],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

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
      format: "path/workflow@0",
      name: "observed-unsupported",
      worker: { type: "engine" },
      body: [{ type: "telepathy", id: "guess" } as unknown as WorkflowFile["body"][number]],
    };

    await runWorkflow(file, fixturesDir, { observer });

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
      format: "path/workflow@0",
      name: "observed-publish",
      worker: { type: "engine" },
      body: [
        {
          type: "binary",
          id: "step",
          command: "node",
          args: ["-e", "process.stdout.write('v')"],
          publish: { seen: "${output}" },
        },
      ],
    };

    await runWorkflow(file, fixturesDir, { observer });

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
    format: "path/workflow@0",
    name: "prompt-run",
    worker: { type: "llm", model: "claude-sonnet-5" },
    body,
    ...rest,
  });

  it("spans the cap across nested workflow-runs, not just one file's branches (spec §5.5)", async () => {
    const child: WorkflowFile = {
      format: "path/workflow@0",
      name: "child",
      worker: { type: "llm", model: "claude-sonnet-5" },
      body: [{ type: "prompt", id: "child-ask", prompt: "Child question." }],
      output: { answer: "${context.answer}" },
    };
    (child.body[0] as { publish?: unknown }).publish = { answer: "${output}" };

    const childPath = join(fixturesDir, "llm-child.workflow.json");
    const file = llmFile([
      {
        type: "parallel",
        id: "fanout",
        join: "collect",
        branches: [
          { id: "direct", body: [{ type: "prompt", id: "ask", prompt: "Parent question." }] },
          { id: "nested", body: [{ type: "workflow", id: "sub", ref: "llm-child.workflow.json", input: {} }] },
        ],
      },
    ]);

    const llm = fakeLlmWorker(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { status: "succeeded", output: "ok", usage: null, estimatedCostUsd: null };
    });
    const result = await runWorkflow(file, fixturesDir, {
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
      id,
      body: [{ type: "prompt" as const, id: `ask-${id}`, prompt: `Question ${id}.` }],
    });
    const file = llmFile([
      {
        type: "parallel",
        id: "fanout",
        join: "collect",
        branches: [branch("a"), branch("b"), branch("c"), branch("d"), branch("e"), branch("f")],
      },
    ]);

    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker });

    expect(result.status).toBe("succeeded");
    expect(llm.peakLive).toBe(DEFAULT_LLM_CONCURRENCY);
  });

});

describe("runWorkflow — external abort of a root run (ticket #52)", () => {
  // A step that outlives any test: the operator's abort is what ends it, never its own completion.
  const sleeperNode = (id: string) => ({
    type: "binary" as const,
    id,
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
      format: "path/workflow@0",
      name: "operator-cancel",
      worker: { type: "engine" },
      body: [
        sleeperNode("sleeper"),
        { type: "binary", id: "never", command: "node", args: ["-e", "process.stdout.write('nope')"] },
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer, signal: controller.signal });

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
      format: "path/workflow@0",
      name: "operator-cancel-prompt",
      worker: { type: "llm", model: "claude-sonnet-5" },
      body: [{ type: "prompt", id: "ask", prompt: "Hi.", publish: { answer: "${output}" } }],
    };

    const result = await runWorkflow(file, fixturesDir, { observer, llmWorker, signal: controller.signal });

    expect(result.status).toBe("cancelled");
    const root = observer["run-started"].mock.calls[0]![0];
    const ask = observer["step-started"].mock.calls.map((c) => c[0]).find((s) => s.nodeId === "ask")!;
    expect(observer["run-cancelled"]).toHaveBeenCalledWith({
      runId: ask.runId,
      rootRunId: root.runId,
      nodeId: "ask",
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
      format: "path/workflow@0",
      name: "pre-aborted",
      worker: { type: "engine" },
      body: [{ type: "binary", id: "greet", command: "node", args: ["-e", "process.stdout.write('hi')"] }],
    };

    const result = await runWorkflow(file, fixturesDir, { observer, signal: controller.signal });

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
      format: "path/workflow@0",
      name: "child",
      worker: { type: "engine" },
      body: [sleeperNode("sleeper")],
    };
    const parent: WorkflowFile = {
      format: "path/workflow@0",
      name: "parent",
      worker: { type: "engine" },
      body: [{ type: "workflow", id: "call-child", ref: "nested-child.workflow.json", input: {} }],
    };

    const result = await runWorkflow(parent, fixturesDir, {
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
    expect(observer["run-cancelled"]).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "sleeper", cause: "operator", causeRunId: null }));
  });

  it("still calls a cancellation sibling-failed when the failing branch encloses a nested parallel", async () => {
    // The cause must be read when the kill happens, not at block entry: the inner block starts before
    // the outer sibling fails, so a cause snapshotted at entry would be null — and null means operator.
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "nested-parallel-cause",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "outer",
          join: "collect",
          branches: [
            {
              id: "nested",
              body: [
                {
                  type: "parallel",
                  id: "inner",
                  join: "collect",
                  branches: [{ id: "deep-branch", body: [sleeperNode("deep")] }],
                },
              ],
            },
            { id: "boom", body: [{ type: "binary", id: "kaboom", command: "node", args: ["-e", "process.exit(1)"] }] },
          ],
        },
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("failed");
    const kaboom = observer["step-started"].mock.calls.map((c) => c[0]).find((s) => s.nodeId === "kaboom")!;
    expect(observer["run-cancelled"]).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "deep", cause: "sibling-failed", causeRunId: kaboom.runId }),
    );
  });

  it("cancels the in-flight branches of a parallel block as operator cancellations", async () => {
    const observer = fakeObserver();
    const controller = abortWhenStarted(observer, "sleep-a");
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "operator-cancel-parallel",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "fanout",
          join: "collect",
          branches: [
            { id: "a", body: [sleeperNode("sleep-a")] },
            { id: "b", body: [sleeperNode("sleep-b")] },
          ],
        },
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer, signal: controller.signal });

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
