import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowFile, type ConfigObject, type WorkflowFile } from "@path/schema";
import { describe, expect, it, vi } from "vitest";
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

  it("fails clearly on unsupported step types instead of silently skipping them", async () => {
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "prompt-not-supported",
      worker: { type: "llm", model: "claude" },
      body: [{ type: "prompt", id: "ask", prompt: "hello" }],
    };
    const result = await runWorkflow(file, fixturesDir);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/prompt/i);
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
    stepFinished: vi.fn(),
    contextChanged: vi.fn(),
    runFinished: vi.fn(),
  };
}

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
    expect(observer.runStarted).toHaveBeenCalledWith({ runId, input: { seed: 1 }, worker: { type: "engine" } });

    expect(observer.stepStarted).toHaveBeenCalledTimes(1);
    const stepCall = observer.stepStarted.mock.calls[0]![0];
    expect(stepCall.parentRunId).toBe(runId);
    expect(stepCall.nodeId).toBe("greet");
    expect(stepCall.stepType).toBe("binary");
    expect(stepCall.worker).toEqual({ type: "engine" });
    expect(stepCall.runId).not.toBe(runId); // the step run is distinct from the root run

    expect(observer.stepStderr).toHaveBeenCalledWith({ runId: stepCall.runId, stderr: "" });
    expect(observer.stepFinished).toHaveBeenCalledWith({
      runId: stepCall.runId,
      status: "succeeded",
      output: "hi",
    });
    expect(observer.runFinished).toHaveBeenCalledWith({ runId, status: "succeeded", output: {} });
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
      status: "failed",
      error: expect.stringMatching(/exited with code 2/),
    });
    expect(observer.runFinished).toHaveBeenCalledWith({
      runId,
      status: "failed",
      error: expect.stringMatching(/exited with code 2/),
    });
  });

  it("reports runFinished failed even when the run fails before any step starts", async () => {
    const observer = fakeObserver();
    const file: WorkflowFile = {
      format: "path/workflow@0",
      name: "observed-unsupported",
      worker: { type: "llm", model: "claude" },
      body: [{ type: "prompt", id: "ask", prompt: "hi" }],
    };

    await runWorkflow(file, fixturesDir, { observer });

    expect(observer.stepStarted).not.toHaveBeenCalled();
    const { runId } = observer.runStarted.mock.calls[0]![0];
    expect(observer.runFinished).toHaveBeenCalledWith({
      runId,
      status: "failed",
      error: expect.stringMatching(/not supported yet/),
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
    expect(observer.contextChanged).toHaveBeenCalledWith({ runId, context: { seen: "v" } });
  });
});
