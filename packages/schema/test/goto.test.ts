import { describe, expect, it } from "vitest";
import { gotoIssues } from "../src/goto.js";
import { instantiate } from "../src/instantiate.js";
import type { WorkflowNode } from "../src/node-type.js";
import { isStepType, childBodies, mapChildBodies } from "../src/node-walk.js";
import { makeNodeSchema, RESERVED_TYPE_NAMES } from "../src/nodes.js";
import { safeParseStepTemplate } from "../src/step-template.js";
import { safeParseWorkflowFile } from "../src/workflow-file.js";
import { FORMAT_VERSION, type WorkflowFile } from "../src/workflow-file-type.js";
import { builtinRegistry } from "./builtin-registry.js";

// The goto rule module (docs/spec/goto.md §2, ADR 0056/0058): the node grammar, and the four load
// refusals as data, one issue per offender, all in one failed parse.

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

let next = 100;
function step(name: string): WorkflowNode {
  return { type: "binary", id: uuid(next++), name, command: "echo" };
}

function goto(name: string, target: string, max_jumps: number | string = 3): WorkflowNode {
  return { type: "goto", id: uuid(next++), name, target, max_jumps };
}

const cond = { type: "exists", path: "context.x" } as const;

function file(body: WorkflowNode[]): WorkflowFile {
  return { format: FORMAT_VERSION, id: uuid(1), name: "flow", body };
}

function parse(body: unknown[]) {
  return safeParseWorkflowFile({ format: FORMAT_VERSION, id: uuid(1), name: "flow", body }, builtinRegistry);
}

function errorsOf(body: unknown[]): string[] {
  const result = parse(body);
  expect(result.success).toBe(false);
  return result.success ? [] : result.errors;
}

describe("goto — the node grammar", () => {
  it("G-S-01: a first-level backward goto and a guarded goto in a branch arm load", () => {
    const result = parse([
      step("draft"),
      goto("back", "draft"),
      {
        type: "branch",
        id: uuid(2),
        name: "check",
        arms: [{ when: cond, node: goto("retry", "draft") }],
      },
    ]);
    expect(result).toMatchObject({ success: true });
  });

  it("is strict: no step envelope and no other key", () => {
    const withConfig = { ...goto("g", "a"), config: { x: 1 } };
    const errors = errorsOf([step("a"), withConfig]);
    expect(errors.join("\n")).toMatch(/config/);
    expect(errorsOf([step("a"), { ...goto("g", "a"), input: {} }]).join("\n")).toMatch(/input/);
  });

  it("requires target as a name string", () => {
    const { target: _target, ...noTarget } = goto("g", "a") as { target: string };
    expect(errorsOf([step("a"), noTarget]).join("\n")).toMatch(/target/);
    expect(errorsOf([step("a"), goto("g", "Not-A-Name")]).join("\n")).toMatch(/target/);
  });

  it("G-S-07: max_jumps omitted is refused; 0 is refused; an interpolation loads", () => {
    const { max_jumps: _m, ...noMax } = goto("g", "a") as { max_jumps: number };
    expect(errorsOf([step("a"), noMax]).join("\n")).toMatch(/max_jumps/);
    expect(errorsOf([step("a"), goto("g", "a", 0)]).join("\n")).toMatch(/max_jumps/);
    expect(parse([step("a"), goto("g", "a", "${config.n}")])).toMatchObject({ success: true });
  });

  it("G-S-06: the target may be a first-level branch, while-do, parallel, checkpoint or goto", () => {
    const result = parse([
      { type: "branch", id: uuid(2), name: "b", arms: [{ when: cond, node: step("b-arm") }] },
      { type: "while-do", id: uuid(3), name: "w", condition: cond, max_iterations: 2, node: step("w-body") },
      { type: "parallel", id: uuid(4), name: "p", join: "collect", branches: [step("p-one")] },
      { type: "checkpoint", id: uuid(5), name: "c", condition: cond },
      goto("other", "b"),
      goto("to-b", "b"),
      goto("to-w", "w"),
      goto("to-p", "p"),
      goto("to-c", "c"),
      goto("to-goto", "other"),
    ]);
    expect(result).toMatchObject({ success: true });
  });
});

describe("gotoIssues — the four load refusals, as data", () => {
  it("G-S-02: target-absent at `target`, with the spec message", () => {
    const g = goto("jump", "retry");
    const issues = gotoIssues(file([step("a"), g]));
    expect(issues).toEqual([
      {
        rule: "target-absent",
        nodeId: g.id,
        path: ["body", 1, "target"],
        message: 'goto target "retry" not found in this file',
      },
    ]);
  });

  it("G-S-03: target-inner when the target sits in a first-level sequence", () => {
    const g = goto("jump", "check");
    const issues = gotoIssues(
      file([{ type: "sequence", id: uuid(2), name: "seq", body: [step("check")] }, g]),
    );
    expect(issues).toEqual([
      {
        rule: "target-inner",
        nodeId: g.id,
        path: ["body", 1, "target"],
        message: 'goto target "check" is not a first-level node',
      },
    ]);
  });

  it("G-S-04: target-self when a goto targets itself", () => {
    const g = goto("loop", "loop");
    expect(gotoIssues(file([step("a"), g]))).toEqual([
      { rule: "target-self", nodeId: g.id, path: ["body", 1, "target"], message: 'goto "loop" targets itself' },
    ]);
  });

  it("G-S-05: one placement issue per goto under while-do / parallel, at the goto node", () => {
    const inLoop = goto("x", "a");
    const inFan = goto("y", "a");
    const issues = gotoIssues(
      file([
        step("a"),
        {
          type: "while-do",
          id: uuid(2),
          name: "poll",
          condition: cond,
          max_iterations: 2,
          node: { type: "sequence", id: uuid(3), name: "seq", body: [inLoop] },
        },
        {
          type: "parallel",
          id: uuid(4),
          name: "fan",
          join: "collect",
          branches: [
            { type: "branch", id: uuid(5), name: "arm", arms: [{ when: cond, node: inFan }] },
          ],
        },
      ]),
    );
    expect(issues).toEqual([
      {
        rule: "placement",
        nodeId: inLoop.id,
        path: ["body", 1, "node", "body", 0],
        message: 'goto "x" may not sit under while-do "poll"',
      },
      {
        rule: "placement",
        nodeId: inFan.id,
        path: ["body", 2, "branches", 0, "arms", 0, "node"],
        message: 'goto "y" may not sit under parallel "fan"',
      },
    ]);
  });

  it("G-S-05: the load refuses both misplaced gotos in one failed parse", () => {
    const errors = errorsOf([
      step("a"),
      { type: "while-do", id: uuid(2), name: "poll", condition: cond, max_iterations: 2, node: goto("x", "a") },
      { type: "parallel", id: uuid(4), name: "fan", join: "collect", branches: [goto("y", "a")] },
    ]);
    expect(errors).toEqual([
      'body.1.node: goto "x" may not sit under while-do "poll"',
      'body.2.branches.0: goto "y" may not sit under parallel "fan"',
    ]);
  });

  it("the load reports the target refusals at the `target` path", () => {
    expect(errorsOf([step("a"), goto("jump", "retry")])).toEqual([
      'body.1.target: goto target "retry" not found in this file',
    ]);
  });

  it("reports nothing for a goto-free file", () => {
    expect(gotoIssues(file([step("a"), step("b")]))).toEqual([]);
  });
});

describe("goto — a controller and a reserved name", () => {
  it("is a controller with no child body", () => {
    const g = goto("g", "a");
    expect(isStepType("goto")).toBe(false);
    expect(childBodies(g)).toEqual([]);
    expect(mapChildBodies(g, () => [])).toBe(g);
  });

  it("is the seventh reserved name, so a plugin may not claim it", () => {
    expect(RESERVED_TYPE_NAMES).toContain("goto");
    expect(RESERVED_TYPE_NAMES).toHaveLength(7);
    const registry = { goto: { fields: {}, config: {}, workers: { only: {} }, defaultWorker: "only" } };
    expect(() => makeNodeSchema(registry)).toThrowError(/seven control names/);
  });
});

describe("goto — a Step-Template body", () => {
  it("G-S-11: a dangling target stores in a template; the instance fails the target file's check", () => {
    const g = goto("jump", "missing");
    const template = safeParseStepTemplate(
      { format: FORMAT_VERSION, id: uuid(1), description: "a jump", body: [step("a"), g] },
      builtinRegistry,
    );
    expect(template.success).toBe(true);
    if (!template.success) return;

    // Instantiation re-mints ids and does not rewire targets, so the landed goto still names "missing".
    const landed = instantiate(template.data.body);
    expect(errorsOf([step("host"), ...landed])).toEqual(['body.2.target: goto target "missing" not found in this file']);
  });
});
