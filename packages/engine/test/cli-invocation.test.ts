import { describe, expect, it } from "vitest";
import { parseRunInvocation } from "../src/cli.js";

/**
 * The `path run` **invocation value** (#architecture-deepening): the three forms the one command line
 * accepts, parsed into an arm that carries only what its form can use. This is the parser's own seam —
 * before, its contract was reachable only by running a whole command and reading the exit code, and its
 * compatibility matrix was a dozen `if` blocks every consumer had to re-read.
 */

describe("parseRunInvocation — the three forms", () => {
  it("parses a fresh launch with every launch flag", () => {
    const parsed = parseRunInvocation([
      "wf.workflow.json",
      "--config",
      "conf.json",
      "--set",
      "model=gpt",
      "--worker-default",
      "prompt=sdk",
      "--context",
      "ctx.json",
      "--set-context",
      "k=v",
      "--log-backends",
      "db",
      "--processor-concurrency",
      "2",
    ]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.invocation).toEqual({
      kind: "launch",
      workflowPath: "wf.workflow.json",
      configFile: "conf.json",
      setPairs: [["model", "gpt"]],
      workerDefaultPairs: [["prompt", "sdk"]],
      contextFile: "ctx.json",
      setContextPairs: [["k", "v"]],
      logBackends: ["db"],
      processorConcurrency: 2,
    });
  });

  it("parses the resume form, with the rerun boundary it may carry", () => {
    const parsed = parseRunInvocation(["wf.workflow.json", "--resume", "root-1", "--from", "run-7"]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.invocation).toMatchObject({ kind: "resume", resumeRootRunId: "root-1", rerunFromRunId: "run-7" });
    // The launch-only flags are absent from the value, not merely ignored.
    expect(parsed.invocation).not.toHaveProperty("contextFile");
    expect(parsed.invocation).not.toHaveProperty("workerDefaultPairs");
  });

  it("parses the listing form, which carries the source tree and nothing else", () => {
    const parsed = parseRunInvocation(["wf.workflow.json", "-C", "/store", "--resume", "root-1", "--list-eligible"]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.invocation).toEqual({
      kind: "list-eligible",
      workflowPath: "wf.workflow.json",
      storeDir: "/store",
      resumeRootRunId: "root-1",
    });
  });

  it("takes -C wherever it appears, including ahead of the workflow positional", () => {
    const parsed = parseRunInvocation(["-C", "/store", "wf.workflow.json"]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.invocation).toMatchObject({ workflowPath: "wf.workflow.json", storeDir: "/store" });
  });
});

describe("parseRunInvocation — the compatibility refusals", () => {
  const refusals: readonly (readonly [string, string[], RegExp])[] = [
    ["--from requires --resume", ["wf.json", "--from", "run-7"], /--from requires --resume/],
    ["--list-eligible requires --resume", ["wf.json", "--list-eligible"], /--list-eligible requires --resume/],
    ["--list-eligible excludes --from", ["wf.json", "--resume", "r", "--list-eligible", "--from", "k"], /cannot be combined with --from/],
    ["--list-eligible launches nothing", ["wf.json", "--resume", "r", "--list-eligible", "--config", "c.json"], /cannot be combined with --config/],
    ["a resume restores context", ["wf.json", "--resume", "r", "--context", "c.json"], /cannot be combined with --resume/],
    ["a resume fixes the worker-default", ["wf.json", "--resume", "r", "--worker-default", "prompt=sdk"], /--worker-default cannot be combined with --resume/],
  ];

  it.each(refusals)("refuses %s", (_name, argv, message) => {
    const parsed = parseRunInvocation([...argv]);

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error).toMatch(message);
  });

  it("refuses an unknown flag and a missing workflow positional", () => {
    expect(parseRunInvocation(["wf.json", "--nope"])).toMatchObject({ success: false });
    expect(parseRunInvocation([])).toMatchObject({ success: false });
  });
});
