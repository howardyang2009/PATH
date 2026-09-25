import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigObject, WorkflowFile } from "@path/schema";
import { scanStepPlugins, type LoadedStepPluginRegistry } from "../src/plugin/scan.js";
import { analyzeRunStart } from "../src/run-workflow.js";
import { stampNames } from "./stamp-names.js";

/**
 * The run-start analysis on its own seam: the staging that gates a run before its first node —
 * collect config, resolve `$env`, collect `$secret`, then validate — and the load-bearing order
 * between them. Its edges used to be reachable only by starting a whole run; here they are one call.
 */

let registry: LoadedStepPluginRegistry;
beforeAll(async () => {
  registry = await scanStepPlugins();
});

// A single binary step, whose empty config fragment always validates — so a binary-only file isolates
// the `$env`/`$secret` passes from the config-fragment check.
function binaryFile(config?: ConfigObject): WorkflowFile {
  return stampNames({
    format: "path/workflow@5",
    id: "wf-id",
    name: "bin",
    ...(config ? { config } : {}),
    body: [{ type: "binary", id: "run", command: "true" }],
  } as unknown as WorkflowFile);
}

// A single `prompt` step. `prompt`'s config fragment requires `model`, so a file that declares none
// fails the config gate — the lever for the validation-vs-`$env` ordering.
function promptFile(config?: ConfigObject): WorkflowFile {
  return stampNames({
    format: "path/workflow@5",
    id: "wf-id",
    name: "ask",
    ...(config ? { config } : {}),
    body: [{ type: "prompt", id: "ask", prompt: "hi" }],
  } as unknown as WorkflowFile);
}

describe("analyzeRunStart — the masker", () => {
  it("collects a $secret from resolved config into a non-empty masker, and proceeds", () => {
    const { masker, runStartFailure } = analyzeRunStart(
      binaryFile({ token: { $secret: "sk-abcdef123456" } }),
      "/tmp",
      {},
      {},
      registry,
    );
    expect(runStartFailure).toBeUndefined();
    expect(masker.isEmpty).toBe(false);
    expect(masker.maskString("here is sk-abcdef123456")).not.toContain("sk-abcdef123456");
  });

  it("yields an empty masker when no config carries a secret", () => {
    const { masker, runStartFailure } = analyzeRunStart(binaryFile({ plain: "value" }), "/tmp", {}, {}, registry);
    expect(runStartFailure).toBeUndefined();
    expect(masker.isEmpty).toBe(true);
  });
});

describe("analyzeRunStart — the run-start gate", () => {
  it("proceeds when a prompt step's required model resolves", () => {
    const { runStartFailure } = analyzeRunStart(promptFile({ model: "claude-x" }), "/tmp", {}, {}, registry);
    expect(runStartFailure).toBeUndefined();
  });

  it("fails naming the config-fragment mismatch when a prompt step has no model", () => {
    const { runStartFailure } = analyzeRunStart(promptFile(), "/tmp", {}, {}, registry);
    expect(runStartFailure).toBeDefined();
    expect(runStartFailure).toMatch(/model/i);
  });

  it("names every unset $env variable", () => {
    const { runStartFailure } = analyzeRunStart(
      binaryFile({ pin: { $env: "PATH_MISSING_VAR_XYZ" } }),
      "/tmp",
      {},
      {}, // empty env snapshot: the variable is unset
      registry,
    );
    expect(runStartFailure).toBeDefined();
    expect(runStartFailure).toContain("PATH_MISSING_VAR_XYZ");
  });

  it("lets an unset $env pre-empt the config-fragment check — env fails first (staging is load-bearing)", () => {
    // A prompt step with no model (config would fail) AND an unset $env in the same file. The env
    // failure must win: config cannot be validated against a value it could not resolve.
    const file = promptFile({ pin: { $env: "PATH_MISSING_VAR_XYZ" } });
    const { runStartFailure } = analyzeRunStart(file, "/tmp", {}, {}, registry);
    expect(runStartFailure).toContain("PATH_MISSING_VAR_XYZ");
    expect(runStartFailure).not.toMatch(/model/i);
  });
});

// Temporary scaffolding (#614): the schema accepts a goto before the engine can execute one. Until the
// execution ticket lands, a run whose ref tree holds a goto fails before its first node, naming it.
describe("analyzeRunStart — goto is not yet executable", () => {
  const gotoFile = (): WorkflowFile =>
    stampNames({
      format: "path/workflow@5",
      id: "wf-id",
      name: "loop",
      body: [
        { type: "binary", id: "run", command: "true" },
        { type: "goto", id: "back", target: "run", max_jumps: 3 },
      ],
    } as unknown as WorkflowFile);

  it("fails a file holding a goto, naming it", () => {
    const { runStartFailure } = analyzeRunStart(gotoFile(), "/tmp", {}, {}, registry);
    expect(runStartFailure).toBe('run failed before its first step: goto "back" is not yet executable');
  });

  it("fails a root whose ref'd child file holds a goto", () => {
    const root = stampNames({
      format: "path/workflow@5",
      id: "wf-root",
      name: "root",
      body: [{ type: "workflow", id: "child", ref: "child.workflow.json" }],
    } as unknown as WorkflowFile);
    const files = new Map([["/tmp/child.workflow.json", gotoFile()]]);
    const { runStartFailure } = analyzeRunStart(root, "/tmp", { files }, {}, registry);
    expect(runStartFailure).toBe('run failed before its first step: goto "back" is not yet executable');
  });

  it("leaves a goto-free file alone", () => {
    const { runStartFailure } = analyzeRunStart(binaryFile(), "/tmp", {}, {}, registry);
    expect(runStartFailure).toBeUndefined();
  });
});
