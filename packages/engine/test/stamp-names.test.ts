import { describe, expect, it } from "vitest";
import { stampGuids, stampNames, stampNodes } from "./stamp-names.js";

/**
 * The guard on the inline-fixture stampers (#282).
 *
 * The `.ts` inline fixtures are the larger container-slot population by 10:1 (#266), and the ones
 * built through these stampers are the only ones **nothing** type-checks: the stampers take
 * `unknown` and cast their way to a `WorkflowFile`, so `tsc` never sees the literal and the schema
 * never parses it. A slot written in the deleted `@1` shape would therefore be handed to the engine
 * as a tree it cannot run — an arm with no `node`, a `while-do` with no body, a branch that is not a
 * node — and the failure would surface as a confusing runtime error inside the executor rather than
 * as "this fixture is still `@1`". The stampers refuse it instead.
 */
const step = (id: string) => ({ type: "binary", id, command: "echo" });

describe("stampNames — refuses a fixture still written in the @1 container shape", () => {
  it("refuses an @1 parallel branch wrapper — a branch is a node in @2", () => {
    expect(() =>
      stampNames({
        body: [{ type: "parallel", id: "fan", join: "collect", branches: [{ id: "left", body: [step("a")] }] }],
      }),
    ).toThrow(/@1 .*branch wrapper.*parallel\.branches/i);
  });

  it("refuses a branch arm carrying the @1 `body` array instead of a single `node`", () => {
    expect(() =>
      stampNames({
        body: [{ type: "branch", id: "route", arms: [{ when: { type: "exists", path: "context.x" }, body: [step("a")] }] }],
      }),
    ).toThrow(/@1 .*arm.*`node`/i);
  });

  it("refuses an arm carrying no occupant at all — the same stale fixture, one key further along", () => {
    expect(() =>
      stampNames({ body: [{ type: "branch", id: "route", arms: [{ when: { type: "exists", path: "context.x" } }] }] }),
    ).toThrow(/route.*arm.*`node`/i);
  });

  it("refuses a bare-array `else`", () => {
    expect(() =>
      stampNames({
        body: [
          {
            type: "branch",
            id: "route",
            arms: [{ when: { type: "exists", path: "context.x" }, node: step("a") }],
            else: [step("b")],
          },
        ],
      }),
    ).toThrow(/@1 .*else/i);
  });

  it("refuses a while-do carrying the @1 `body` array instead of a single `node`", () => {
    expect(() =>
      stampNames({
        body: [
          {
            type: "while-do",
            id: "spin",
            condition: { type: "exists", path: "context.x" },
            max_iterations: 2,
            body: [step("a")],
          },
        ],
      }),
    ).toThrow(/@1 .*while-do.*`node`/i);
  });

  it("names the node it refused, so a fixture in a 2000-line test file is findable", () => {
    expect(() =>
      stampNames({
        body: [
          {
            type: "while-do",
            id: "spin",
            condition: { type: "exists", path: "context.x" },
            max_iterations: 2,
            body: [step("a")],
          },
        ],
      }),
    ).toThrow(/spin/);
  });

  it("reaches an @1 slot nested under a @2 one", () => {
    expect(() =>
      stampNames({
        body: [
          {
            type: "parallel",
            id: "fan",
            join: "collect",
            branches: [
              {
                type: "while-do",
                id: "spin",
                condition: { type: "exists", path: "context.x" },
                max_iterations: 2,
                body: [step("a")],
              },
            ],
          },
        ],
      }),
    ).toThrow(/spin/);
  });
});

describe("stampNames — the @2 shapes it is there to stamp", () => {
  it("stamps `name = id` through every single-node slot and a sequence body", () => {
    const file = stampNames({
      body: [
        {
          type: "parallel",
          id: "fan",
          join: "collect",
          branches: [
            {
              type: "branch",
              id: "route",
              arms: [
                {
                  when: { type: "exists", path: "context.x" },
                  node: {
                    type: "while-do",
                    id: "spin",
                    condition: { type: "exists", path: "context.x" },
                    max_iterations: 2,
                    node: { type: "sequence", id: "steps", body: [step("a"), step("b")] },
                  },
                },
              ],
              else: step("fallback"),
            },
          ],
        },
      ],
    });

    expect(file.format).toBe("path/workflow@2");
    const parallel = file.body[0]!;
    if (parallel.type !== "parallel") throw new Error("expected a parallel node");
    const branch = parallel.branches[0]!;
    if (branch.type !== "branch") throw new Error("expected the branch to be a node");
    expect(branch.name).toBe("route");
    const loop = branch.arms[0]!.node;
    if (loop.type !== "while-do") throw new Error("expected a while-do in the arm");
    expect(loop.name).toBe("spin");
    const sequence = loop.node;
    if (sequence.type !== "sequence") throw new Error("expected a sequence in the loop");
    expect(sequence.body.map((node) => node.name)).toEqual(["a", "b"]);
    expect(branch.else?.name).toBe("fallback");
  });

  it("leaves a name that was written explicitly alone", () => {
    const [node] = stampNodes([{ type: "binary", id: "guid-ish", name: "human", command: "echo" }]);
    expect(node!.name).toBe("human");
    expect(node!.id).toBe("guid-ish");
  });
});

describe("stampGuids — the same guard on the schema-valid stamper", () => {
  it("refuses an @1 arm `body`", () => {
    expect(() =>
      stampGuids({
        body: [{ type: "branch", id: "route", arms: [{ when: { type: "exists", path: "context.x" }, body: [step("a")] }] }],
      }),
    ).toThrow(/@1 .*arm.*`node`/i);
  });

  it("mints a fresh GUID per node while keeping the human id as the name", () => {
    const file = stampGuids({ body: [{ type: "sequence", id: "steps", body: [step("a")] }] });
    const sequence = file.body[0]!;
    if (sequence.type !== "sequence") throw new Error("expected a sequence");
    expect(sequence.name).toBe("steps");
    expect(sequence.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sequence.body[0]!.name).toBe("a");
  });
});
