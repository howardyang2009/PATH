import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowFile, type ConfigObject, type WorkflowFile } from "@path/schema";
import { describe, expect, it, vi } from "vitest";
import type { LlmWorker, PromptRequest, PromptResult } from "../src/llm/llm-worker.js";
import { DEFAULT_LLM_CONCURRENCY } from "../src/llm/processor-semaphore.js";
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

  // Captures every observer payload as it crosses the persistence boundary — this stands in for
  // what would otherwise be written to disk / a backend.
  function recordingObserver(): { observer: RunObserver; persisted: () => string } {
    const seen: unknown[] = [];
    const capture = (info: unknown) => {
      seen.push(info);
    };
    return {
      observer: {
        runStarted: capture,
        stepStarted: capture,
        stepStderr: capture,
        stepFinished: capture,
        contextChanged: capture,
        runFinished: capture,
      },
      persisted: () => JSON.stringify(seen),
    };
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

function fakeObserver(): { [K in keyof Required<RunObserver>]: ReturnType<typeof vi.fn> } {
  return {
    runStarted: vi.fn(),
    stepStarted: vi.fn(),
    stepStderr: vi.fn(),
    stepUsage: vi.fn(),
    stepFinished: vi.fn(),
    contextChanged: vi.fn(),
    joinApplied: vi.fn(),
    runCancelled: vi.fn(),
    runFinished: vi.fn(),
    checkpointEvaluated: vi.fn(),
    branchTaken: vi.fn(),
    branchNoMatch: vi.fn(),
    iterationStarted: vi.fn(),
    loopExited: vi.fn(),
  };
}

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
    expect(observer.runStarted).toHaveBeenCalledTimes(1);
    const { runId } = observer.runStarted.mock.calls[0]![0];
    expect(observer.runStarted).toHaveBeenCalledWith({
      runId,
      rootRunId: runId, // the root run is its own root
      parentRunId: null,
      nodeId: null,
      input: { seed: 1 },
      worker: { type: "engine" },
    });

    expect(observer.stepStarted).toHaveBeenCalledTimes(1);
    const stepCall = observer.stepStarted.mock.calls[0]![0];
    expect(stepCall.parentRunId).toBe(runId);
    expect(stepCall.rootRunId).toBe(runId);
    expect(stepCall.nodeId).toBe("greet");
    expect(stepCall.stepType).toBe("binary");
    expect(stepCall.worker).toEqual({ type: "engine" });
    expect(stepCall.runId).not.toBe(runId); // the step run is distinct from the root run

    expect(observer.stepStderr).toHaveBeenCalledWith({ runId: stepCall.runId, rootRunId: runId, stderr: "" });
    expect(observer.stepFinished).toHaveBeenCalledWith({
      runId: stepCall.runId,
      rootRunId: runId,
      status: "succeeded",
      output: "hi",
    });
    expect(observer.runFinished).toHaveBeenCalledWith({ runId, rootRunId: runId, status: "succeeded", output: {} });
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
    const { runId } = observer.runStarted.mock.calls[0]![0];
    const stepCall = observer.stepStarted.mock.calls[0]![0];
    expect(observer.stepFinished).toHaveBeenCalledWith({
      runId: stepCall.runId,
      rootRunId: runId,
      status: "failed",
      error: expect.stringMatching(/exited with code 2/),
    });
    expect(observer.runFinished).toHaveBeenCalledWith({
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

    expect(observer.stepStarted).not.toHaveBeenCalled();
    const { runId } = observer.runStarted.mock.calls[0]![0];
    expect(observer.runFinished).toHaveBeenCalledWith({
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

    const { runId } = observer.runStarted.mock.calls[0]![0];
    expect(observer.contextChanged).toHaveBeenCalledWith({ runId, rootRunId: runId, context: { seen: "v" } });
  });
});

// A binary step that writes its raw stdin back out — lets a test observe which object flows into
// a node's input (the default-input chain) and out of it again.
function echoStep(id: string) {
  return { type: "binary" as const, id, command: "node", args: ["-e", echoStdinScript()] };
}

// Look up the input object a given node's step-run started with (control nodes have no step-run).
function stepInputFor(observer: ReturnType<typeof fakeObserver>, nodeId: string): unknown {
  return observer.stepStarted.mock.calls.find(([info]) => info.nodeId === nodeId)?.[0].input;
}

describe("runWorkflow — checkpoint nodes (ticket #21)", () => {
  it("checkpoint true forwards its predecessor's output unchanged (transparent) and continues", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "checkpoint-pass",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "produce", command: "node", args: ["-e", "process.stdout.write('hello')"], publish: { seen: "yes" } },
        { type: "checkpoint", id: "gate", condition: { type: "exists", path: "context.seen" } },
        echoStep("consume"),
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("succeeded");
    // transparent: `consume` defaults its input to `produce`'s output, unchanged by the checkpoint.
    expect(stepInputFor(observer, "consume")).toBe("hello");
    const { runId } = observer.runStarted.mock.calls[0]![0];
    expect(observer.checkpointEvaluated).toHaveBeenCalledWith(
      expect.objectContaining({ runId, rootRunId: runId, nodeId: "gate", passed: true, trace: expect.objectContaining({ outcome: "true" }) }),
    );
  });

  it("checkpoint false stops the run as failed and does not run the following node", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "checkpoint-fail",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "produce", command: "node", args: ["-e", "process.stdout.write('x')"], publish: { n: "5" } },
        { type: "checkpoint", id: "gate", condition: { type: "equals", path: "context.n", value: "6" } },
        echoStep("never"),
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/checkpoint "gate"/);
    expect(observer.checkpointEvaluated).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "gate", passed: false }));
    expect(stepInputFor(observer, "never")).toBeUndefined();
  });

  it("a checkpoint whose condition errors (strict semantics) fails the run as checkpoint-failed", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "checkpoint-error",
      worker: { type: "engine" },
      body: [{ type: "checkpoint", id: "gate", condition: { type: "equals", path: "context.absent", value: 1 } }],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("failed");
    expect(observer.checkpointEvaluated).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "gate", passed: false, trace: expect.objectContaining({ outcome: "error" }) }),
    );
  });
});

describe("runWorkflow — branch nodes (ticket #21)", () => {
  it("takes the first arm whose when is true; its output becomes the block output; the default-input chain threads through", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "branch-first-match",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "produce", command: "node", args: ["-e", "process.stdout.write('hello')"], publish: { pick: "b" } },
        {
          type: "branch",
          id: "route",
          arms: [
            { when: { type: "equals", path: "context.pick", value: "a" }, body: [{ type: "binary", id: "arm-a", command: "node", args: ["-e", "process.stdout.write('WRONG')"] }] },
            { when: { type: "equals", path: "context.pick", value: "b" }, body: [echoStep("arm-b")] },
          ],
        },
        echoStep("after"),
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("succeeded");
    // arm-b's first (and only) node defaults its input to the block predecessor's output ("hello").
    expect(stepInputFor(observer, "arm-b")).toBe("hello");
    // the losing arm never ran.
    expect(stepInputFor(observer, "arm-a")).toBeUndefined();
    // the block output (taken arm's last node output) becomes `after`'s default input.
    expect(stepInputFor(observer, "after")).toBe("hello");
    const { runId } = observer.runStarted.mock.calls[0]![0];
    expect(observer.branchTaken).toHaveBeenCalledWith(
      expect.objectContaining({ runId, rootRunId: runId, nodeId: "route", arm: 1, trace: expect.objectContaining({ outcome: "true" }) }),
    );
  });

  it("runs the else body when no arm matches, with arm reported as \"else\" and a null trace", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "branch-else",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "produce", command: "node", args: ["-e", "process.stdout.write('base')"], publish: { pick: "z" } },
        {
          type: "branch",
          id: "route",
          arms: [{ when: { type: "equals", path: "context.pick", value: "a" }, body: [{ type: "binary", id: "arm-a", command: "node", args: ["-e", "process.stdout.write('WRONG')"] }] }],
          else: [echoStep("fallback")],
        },
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("succeeded");
    expect(stepInputFor(observer, "fallback")).toBe("base");
    expect(observer.branchTaken).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "route", arm: "else", trace: null }));
  });

  it("fails the run with branch-no-match when no arm matches and there is no else", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "branch-no-match",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "produce", command: "node", args: ["-e", "process.stdout.write('x')"], publish: { pick: "z" } },
        {
          type: "branch",
          id: "route",
          arms: [
            { when: { type: "equals", path: "context.pick", value: "a" }, body: [echoStep("arm-a")] },
            { when: { type: "equals", path: "context.pick", value: "b" }, body: [echoStep("arm-b")] },
          ],
        },
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/branch "route"/);
    const noMatch = observer.branchNoMatch.mock.calls[0]?.[0];
    expect(noMatch).toMatchObject({ nodeId: "route" });
    expect(noMatch.traces).toHaveLength(2); // every arm's trace
    expect(observer.branchTaken).not.toHaveBeenCalled();
  });
});

describe("runWorkflow — parallel blocks: collect join (ticket #24)", () => {
  // A node script that rendezvous with a sibling through a shared dir: write my flag, then poll for
  // the sibling's — succeeding only if both run concurrently. If the branches ran sequentially the
  // first to run would wait out its deadline and exit non-zero, failing the run. So a *success* is a
  // genuine proof of concurrency (mvp spec §5.2).
  function rendezvousScript() {
    return "const fs=require('fs'),dir=process.argv[1],me=process.argv[2],other=process.argv[3];fs.writeFileSync(dir+'/'+me,'1');const end=Date.now()+3000;(function p(){if(fs.existsSync(dir+'/'+other)){process.stdout.write(me);return;}if(Date.now()>end){process.exit(1);}setTimeout(p,10);})();";
  }

  it("runs sibling branches concurrently and collects a deterministic, addressable output object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "path-parallel-"));
    try {
      const file: WorkflowFile = {
        format: "path/workflow@0",
        name: "collect-concurrent",
        worker: { type: "engine" },
        body: [
          {
            type: "parallel",
            id: "fanout",
            join: "collect",
            branches: [
              {
                id: "alpha",
                body: [
                  { type: "binary", id: "a", command: "node", args: ["-e", rendezvousScript(), dir, "a", "b"], publish: { fromAlpha: "${output}" } },
                ],
              },
              {
                id: "beta",
                body: [
                  { type: "binary", id: "b", command: "node", args: ["-e", rendezvousScript(), dir, "b", "a"], publish: { fromBeta: "${output}" } },
                ],
              },
            ],
          },
          // Default input of the node after the block is the collect output object (§5.4).
          { type: "binary", id: "after", command: "node", args: ["-e", echoStdinScript()], publish: { block: "${output}" } },
        ],
        output: { fromAlpha: "${context.fromAlpha}", fromBeta: "${context.fromBeta}", block: "${context.block}" },
      };

      const result = await runWorkflow(file, fixturesDir);
      expect(result.status).toBe("succeeded");
      const out = result.output as { fromAlpha: string; fromBeta: string; block: string };
      // Branch publishes landed at the join, addressable by their own keys.
      expect(out.fromAlpha).toBe("a");
      expect(out.fromBeta).toBe("b");
      // Collect output is `{ "<branch-id>": <that branch's last output> }`, keyed by branch id.
      expect(JSON.parse(out.block)).toEqual({ alpha: "a", beta: "b" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives each branch a snapshot of context at block entry — a sibling's publish is never visible", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "snapshot-isolation",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "fanout",
          join: "collect",
          branches: [
            {
              id: "writer",
              body: [
                { type: "binary", id: "w", command: "node", args: ["-e", "process.stdout.write('w')"], publish: { written: "${output}" } },
              ],
            },
            {
              id: "reader",
              // Reads a key its sibling publishes; against the entry snapshot it does not exist, so
              // the branch fails — proving siblings never observe each other's writes (§5.3).
              body: [
                { type: "binary", id: "r", command: "node", args: ["-e", echoStdinScript()], input: "${context.written}" },
              ],
            },
          ],
        },
      ],
    };

    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/written/);
  });

  it("a failing branch fails the run, cancels the in-flight sibling, and lands no publishes", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "cancel-sibling",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "fanout",
          join: "collect",
          branches: [
            {
              id: "slow",
              // Sleeps well past the sibling's failure; it must be killed, not allowed to finish.
              body: [
                { type: "binary", id: "sleeper", command: "node", args: ["-e", "setTimeout(()=>process.stdout.write('done'),5000)"], publish: { slow: "${output}" } },
              ],
            },
            {
              id: "boom",
              body: [{ type: "binary", id: "kaboom", command: "node", args: ["-e", "process.exit(1)"] }],
            },
          ],
        },
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/boom/);

    // The failing branch's step run id is the cause the sibling cancellation points back at.
    const boomStep = observer.stepStarted.mock.calls.map((c) => c[0]).find((s) => s.nodeId === "kaboom");
    const sleeperStep = observer.stepStarted.mock.calls.map((c) => c[0]).find((s) => s.nodeId === "sleeper");
    expect(boomStep).toBeDefined();
    expect(sleeperStep).toBeDefined();

    // The sleeper was cancelled best-effort (a distinct status), narrated by run-cancelled.
    expect(observer.runCancelled).toHaveBeenCalledWith({
      runId: sleeperStep!.runId,
      rootRunId: sleeperStep!.rootRunId,
      nodeId: "sleeper",
      causeRunId: boomStep!.runId,
    });
    expect(observer.stepFinished).toHaveBeenCalledWith({ runId: sleeperStep!.runId, rootRunId: sleeperStep!.rootRunId, status: "cancelled" });
    // No join, hence no publishes landed (§5.6): neither the slow branch's buffered publish nor any
    // context write reached the run.
    expect(observer.joinApplied).not.toHaveBeenCalled();
    expect(observer.contextChanged).not.toHaveBeenCalled();
  });

  it("narrates the join with branch ids in declaration order and the published keys", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "join-narrative",
      worker: { type: "engine" },
      body: [
        {
          type: "parallel",
          id: "fanout",
          join: "collect",
          branches: [
            { id: "one", body: [{ type: "binary", id: "s1", command: "node", args: ["-e", "process.stdout.write('1')"], publish: { k1: "${output}" } }] },
            { id: "two", body: [{ type: "binary", id: "s2", command: "node", args: ["-e", "process.stdout.write('2')"], publish: { k2: "${output}" } }] },
          ],
        },
      ],
      output: {},
    };

    const result = await runWorkflow(file, fixturesDir, { observer });
    expect(result.status).toBe("succeeded");
    const { runId } = observer.runStarted.mock.calls[0]![0];
    expect(observer.joinApplied).toHaveBeenCalledWith({
      runId,
      rootRunId: runId,
      nodeId: "fanout",
      branches: ["one", "two"],
      publishedKeys: ["k1", "k2"],
    });
  });
});

describe("runWorkflow — while-do loops (ticket #23)", () => {
  // Reads a JSON number on stdin, writes back +1 as its output. Parsed as json + published so the
  // loop condition (which reads `context.count`) advances each iteration and eventually falls false.
  function incStep(id: string) {
    return {
      type: "binary" as const,
      id,
      command: "node",
      args: ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(String(Number(d)+1)))"],
      parse: "json" as const,
      publish: { count: "${output}" },
    };
  }

  it("runs zero iterations transparently when the condition is false from the start", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "while-zero",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "seed", command: "node", args: ["-e", "process.stdout.write('5')"], parse: "json", publish: { count: "${output}" } },
        {
          type: "while-do",
          id: "loop",
          condition: { type: "range", path: "context.count", max: 2 },
          max_iterations: 10,
          body: [incStep("body")],
        },
        echoStep("after"),
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("succeeded");
    // Body never ran; the block is transparent on the output side (predecessor's output = "5").
    expect(stepInputFor(observer, "body")).toBeUndefined();
    expect(stepInputFor(observer, "after")).toBe(5);
    expect(observer.iterationStarted).not.toHaveBeenCalled();
    const { runId } = observer.runStarted.mock.calls[0]![0];
    expect(observer.loopExited).toHaveBeenCalledWith(
      expect.objectContaining({ runId, rootRunId: runId, nodeId: "loop", reason: "condition-false", iterations: 0, trace: expect.objectContaining({ outcome: "false" }) }),
    );
  });

  it("iterates until the condition falls false, chaining input across iterations; block output is the final iteration's last node output", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "while-count",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "seed", command: "node", args: ["-e", "process.stdout.write('0')"], parse: "json", publish: { count: "${output}" } },
        {
          type: "while-do",
          id: "loop",
          condition: { type: "range", path: "context.count", max: 2 },
          max_iterations: 10,
          body: [incStep("body")],
        },
        echoStep("after"),
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("succeeded");
    // count runs 0 -> 1 -> 2 -> 3; the condition (count <= 2) holds for the first three iterations.
    expect(observer.iterationStarted).toHaveBeenCalledTimes(3);
    // The block output is the last iteration's `body` output (3); `after` chains off it.
    expect(stepInputFor(observer, "after")).toBe(3);
    const { runId } = observer.runStarted.mock.calls[0]![0];
    expect(observer.iterationStarted).toHaveBeenNthCalledWith(1, expect.objectContaining({ nodeId: "loop", iteration: 1 }));
    expect(observer.loopExited).toHaveBeenCalledWith(
      expect.objectContaining({ runId, rootRunId: runId, nodeId: "loop", reason: "condition-false", iterations: 3 }),
    );
  });

  it("fails the run when the condition is still true after max_iterations completed iterations", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "while-cap",
      worker: { type: "engine" },
      body: [
        { type: "binary", id: "seed", command: "node", args: ["-e", "process.stdout.write('0')"], parse: "json", publish: { count: "${output}" } },
        {
          type: "while-do",
          id: "loop",
          condition: { type: "range", path: "context.count", max: 100 },
          max_iterations: 2,
          body: [incStep("body")],
        },
        echoStep("after"),
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/while-do "loop"/);
    expect(observer.iterationStarted).toHaveBeenCalledTimes(2);
    // Post-loop node never runs on a failed loop cap.
    expect(stepInputFor(observer, "after")).toBeUndefined();
    expect(observer.loopExited).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "loop", reason: "max-iterations-exceeded", iterations: 2, trace: expect.objectContaining({ outcome: "true" }) }),
    );
  });

  it("fails the run when the condition evaluation errors (strict semantics)", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "while-error",
      worker: { type: "engine" },
      body: [
        {
          type: "while-do",
          id: "loop",
          condition: { type: "equals", path: "context.absent", value: 1 },
          max_iterations: 3,
          body: [echoStep("body")],
        },
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/while-do "loop"/);
    expect(observer.iterationStarted).not.toHaveBeenCalled();
    expect(observer.loopExited).not.toHaveBeenCalled();
  });

  it("resolves an interpolated max_iterations against config before capping the loop", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "while-cap-interpolated",
      worker: { type: "engine" },
      config: { cap: "2" },
      body: [
        { type: "binary", id: "seed", command: "node", args: ["-e", "process.stdout.write('0')"], parse: "json", publish: { count: "${output}" } },
        {
          type: "while-do",
          id: "loop",
          condition: { type: "range", path: "context.count", max: 100 },
          max_iterations: "${config.cap}",
          body: [incStep("body")],
        },
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    // "2" resolved to the integer 2: the loop caps after exactly two completed iterations.
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/max_iterations \(2\)/);
    expect(observer.iterationStarted).toHaveBeenCalledTimes(2);
    expect(observer.loopExited).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "loop", reason: "max-iterations-exceeded", iterations: 2 }),
    );
  });

  it("fails the run when an interpolated max_iterations resolves to a non-positive integer", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "while-cap-bad",
      worker: { type: "engine" },
      config: { cap: "zero" },
      body: [
        {
          type: "while-do",
          id: "loop",
          condition: { type: "range", path: "context.count", max: 100 },
          max_iterations: "${config.cap}",
          body: [echoStep("body")],
        },
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { observer });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/while-do "loop": max_iterations resolved to "zero", which is not a positive integer/);
    expect(observer.iterationStarted).not.toHaveBeenCalled();
    expect(observer.loopExited).not.toHaveBeenCalled();
  });
});

describe("runWorkflow — prompt steps on the LLM worker (ticket #25)", () => {
  /**
   * A stand-in LLM worker: records every request (so a test can prove one fresh processor per
   * step-run) and tracks how many processors were live at once (so a test can prove the cap).
   */
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

  it("runs a prompt step on the LLM worker with the interpolated prompt, model, and input object", async () => {
    const llm = fakeLlmWorker();
    const file = llmFile(
      [
        {
          type: "prompt",
          id: "summarize",
          prompt: "Summarize ${config.subject}.",
          input: { version: "${context.version}" },
        },
      ],
      {
        config: { subject: "the release" },
        output: { text: "${context.text}" },
      },
    );
    (file.body[0] as { publish?: unknown }).publish = { text: "${output}" };

    const result = await runWorkflow(file, fixturesDir, { input: { version: "1.2.0" }, llmWorker: llm.worker });

    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ text: "ok" });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]).toMatchObject({
      nodeId: "summarize",
      model: "claude-sonnet-5",
      prompt: "Summarize the release.",
      input: { version: "1.2.0" },
      cwd: fixturesDir,
    });
  });

  it("resolves an interpolated model and passes the worker's options bag through untouched", async () => {
    const llm = fakeLlmWorker();
    const options = { mcpServers: { docs: { type: "stdio", command: "docs-server" } } };
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "options-passthrough",
      worker: { type: "llm", model: "${config.model}", options },
      config: { model: "claude-opus-4-8" },
      body: [{ type: "prompt", id: "ask", prompt: "Hi." }],
    };

    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker });

    expect(result.status).toBe("succeeded");
    expect(llm.requests[0]?.model).toBe("claude-opus-4-8");
    expect(llm.requests[0]?.options).toEqual(options);
  });

  it("lets a step-level llm worker override the file's engine worker", async () => {
    const llm = fakeLlmWorker();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "step-worker",
      worker: { type: "engine" },
      body: [
        { type: "prompt", id: "ask", prompt: "Hi.", worker: { type: "llm", model: "claude-haiku-4-5" } },
      ],
    };

    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker });

    expect(result.status).toBe("succeeded");
    expect(llm.requests[0]?.model).toBe("claude-haiku-4-5");
  });

  it("fails the run when a prompt step's effective worker is not an llm worker", async () => {
    const llm = fakeLlmWorker();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "wrong-worker",
      worker: { type: "engine" },
      body: [{ type: "prompt", id: "ask", prompt: "Hi." }],
    };

    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/prompt step "ask"/);
    expect(result.error).toMatch(/llm worker/);
    expect(llm.requests).toEqual([]);
  });

  it("applies parse: json to the prompt output", async () => {
    const llm = fakeLlmWorker(() => ({
      status: "succeeded",
      output: '{"verdict":"pass"}',
      usage: null,
      estimatedCostUsd: null,
    }));
    const file = llmFile(
      [
        {
          type: "prompt",
          id: "judge",
          prompt: "Judge it.",
          parse: "json",
          publish: { verdict: "${output.verdict}" },
        },
      ],
      { output: { verdict: "${context.verdict}" } },
    );

    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker });

    expect(result.status).toBe("succeeded");
    // Parsed, so the output object is dot-path addressable rather than an opaque string.
    expect(result.output).toEqual({ verdict: "pass" });
  });

  it("fails the step when a prompt step's output is not the JSON its parse declares", async () => {
    const llm = fakeLlmWorker(() => ({ status: "succeeded", output: "not json", usage: null, estimatedCostUsd: null }));
    const file = llmFile([{ type: "prompt", id: "judge", prompt: "Judge it.", parse: "json" }]);

    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/step "judge"/);
    expect(result.error).toMatch(/json/i);
  });

  it("fails the run when the processor fails, surfacing the worker's error", async () => {
    const llm = fakeLlmWorker(() => ({
      status: "failed",
      error: 'prompt step "ask" ended with SDK result "error_max_turns"',
      usage: { input_tokens: 9, output_tokens: 0 },
      estimatedCostUsd: 0.02,
    }));
    const file = llmFile([
      { type: "prompt", id: "ask", prompt: "Hi." },
      { type: "binary", id: "never", command: "node", args: ["-e", "process.stdout.write('nope')"] },
    ]);

    const observer: RunObserver = { stepUsage: vi.fn(), stepFinished: vi.fn() };
    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker, observer });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/error_max_turns/);
    // A step that died mid-conversation still spent tokens: they are recorded before it finishes.
    expect(observer.stepUsage).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { input_tokens: 9, output_tokens: 0 }, estimatedCostUsd: 0.02 }),
    );
  });

  it("reports the step run's usage and estimated cost leaf-only, before the step finishes", async () => {
    const llm = fakeLlmWorker();
    const file = llmFile([{ type: "prompt", id: "ask", prompt: "Hi." }]);

    const calls: string[] = [];
    const usageInfo: { runId: string }[] = [];
    const stepRunIds: string[] = [];
    const observer: RunObserver = {
      runStarted: ({ runId }) => {
        calls.push(`runStarted:${runId}`);
      },
      stepStarted: ({ runId }) => {
        stepRunIds.push(runId);
        calls.push("stepStarted");
      },
      stepUsage: (info) => {
        usageInfo.push(info);
        calls.push("stepUsage");
      },
      stepFinished: () => {
        calls.push("stepFinished");
      },
      runFinished: () => {
        calls.push("runFinished");
      },
    };

    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker, observer });

    expect(result.status).toBe("succeeded");
    expect(calls.slice(1)).toEqual(["stepStarted", "stepUsage", "stepFinished", "runFinished"]);
    // Attributed to the prompt step's own run — never to the enclosing workflow-run.
    expect(usageInfo[0]?.runId).toBe(stepRunIds[0]);
    expect(usageInfo[0]).toMatchObject({ usage: { input_tokens: 1, output_tokens: 2 }, estimatedCostUsd: 0.001 });
  });

  it("reports no usage for a step whose worker recorded none", async () => {
    const llm = fakeLlmWorker(() => ({ status: "succeeded", output: "ok", usage: null, estimatedCostUsd: null }));
    const file = llmFile([{ type: "prompt", id: "ask", prompt: "Hi." }]);
    const observer: RunObserver = { stepUsage: vi.fn() };

    await runWorkflow(file, fixturesDir, { llmWorker: llm.worker, observer });

    expect(observer.stepUsage).not.toHaveBeenCalled();
  });

  it("spawns a fresh processor per step-run — no conversational state leaks between steps", async () => {
    const llm = fakeLlmWorker((request) => ({
      status: "succeeded",
      output: `answered:${request.nodeId}`,
      usage: null,
      estimatedCostUsd: null,
    }));
    const file = llmFile([
      { type: "prompt", id: "first", prompt: "First question." },
      { type: "prompt", id: "second", prompt: "Second question." },
    ]);

    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker });

    expect(result.status).toBe("succeeded");
    expect(llm.requests).toHaveLength(2); // one processor per step-run, not one reused session
    expect(llm.requests[1]?.prompt).toBe("Second question.");
    // The second step reads exactly what its input map built — here the default-input chain, which
    // carries the predecessor's *output object*, not its conversation.
    expect(llm.requests[1]?.input).toBe("answered:first");
  });

  it("caps concurrent processors engine-wide, across a parallel block's branches (spec §5.5)", async () => {
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
        branches: [branch("a"), branch("b"), branch("c"), branch("d")],
      },
    ]);

    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker, llmConcurrency: 2 });

    expect(result.status).toBe("succeeded");
    expect(llm.requests).toHaveLength(4); // every branch still ran
    expect(llm.peakLive).toBe(2); // …but never more than the cap at once
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

  it("cancels a prompt step when a sibling parallel branch fails, landing no publish from it", async () => {
    const llm = fakeLlmWorker(async (request) => {
      // Hold the processor open long enough for the sibling's failure to abort it.
      await new Promise((resolve) => {
        if (request.signal?.aborted) {
          resolve(undefined);
          return;
        }
        request.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      });
      return { status: "cancelled" };
    });
    const file = llmFile([
      {
        type: "parallel",
        id: "fanout",
        join: "collect",
        branches: [
          {
            id: "slow",
            body: [{ type: "prompt", id: "ask", prompt: "Hi.", publish: { answer: "${output}" } }],
          },
          {
            id: "boom",
            body: [{ type: "binary", id: "fail", command: "node", args: ["-e", "process.exit(3)"] }],
          },
        ],
      },
    ]);

    const observer: RunObserver = { runCancelled: vi.fn(), stepFinished: vi.fn() };
    const result = await runWorkflow(file, fixturesDir, { llmWorker: llm.worker, observer });

    expect(result.status).toBe("failed"); // the block fails because a branch failed
    expect(observer.runCancelled).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "ask" }));
    expect(observer.stepFinished).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
  });
});
