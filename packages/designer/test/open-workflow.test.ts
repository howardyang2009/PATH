import { FORMAT_VERSION } from "@path/schema";
import { describe, expect, it } from "vitest";
import { openWorkflowFile } from "../src/open-workflow.js";
import { DEFAULT_PLUGINS } from "./stub-server.js";

/** A distinct valid UUIDv4 per seed, so fixtures read as ids without a random source. */
function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

/** A whole valid `@3` file exercising every block shape, each node with a valid id and a unique name. */
function validFile(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "root-flow",
    body: [
      { type: "prompt", id: uuid(2), name: "draft", prompt: "hi" },
      {
        type: "parallel",
        id: uuid(3),
        name: "fan",
        join: "collect",
        branches: [
          { type: "binary", id: uuid(4), name: "build", command: "make" },
          { type: "prompt", id: uuid(5), name: "review", prompt: "check" },
        ],
      },
      {
        type: "branch",
        id: uuid(6),
        name: "gate",
        arms: [{ when: { type: "exists", path: "context.x" }, node: { type: "prompt", id: uuid(7), name: "arm-a", prompt: "a" } }],
        else: { type: "prompt", id: uuid(8), name: "fallback", prompt: "f" },
      },
      {
        type: "while-do",
        id: uuid(9),
        name: "loop",
        condition: { type: "exists", path: "context.y" },
        max_iterations: 3,
        node: {
          type: "sequence",
          id: uuid(10),
          name: "seq",
          body: [{ type: "checkpoint", id: uuid(11), name: "chk", condition: { type: "exists", path: "output.z" } }],
        },
      },
      { type: "workflow", id: uuid(12), name: "sub", ref: "sub/child.workflow.json" },
    ],
  };
}

describe("openWorkflowFile", () => {
  it("opens a valid @3 file with no id stamp (its dirtiness is content-equality, ADR 0030), into the typed model", () => {
    const result = openWorkflowFile(JSON.stringify(validFile()), DEFAULT_PLUGINS);
    expect(result.status).toBe("opened");
    if (result.status !== "opened") return;
    expect(result.idsStamped).toBe(false);
    expect(result.file.name).toBe("root-flow");
    expect(result.file.body).toHaveLength(5);
  });

  it("refuses a file naming a step type absent from the registry, aggregating every absent type + folder", () => {
    const file = validFile();
    (file.body as unknown[]).push(
      { type: "api-call", id: uuid(20), name: "call-a", endpoint: "x" },
      { type: "grpc", id: uuid(21), name: "call-b" },
    );
    const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);

    expect(result.status).toBe("unregistered-types");
    if (result.status !== "unregistered-types") return;
    expect(result.absent).toEqual([
      { type: "api-call", folder: "packages/engine/step-plugins/api-call/" },
      { type: "grpc", folder: "packages/engine/step-plugins/grpc/" },
    ]);
    expect(result.message).toContain("packages/engine/step-plugins/api-call/");
    expect(result.message).toContain("packages/engine/step-plugins/grpc/");
    expect(result.message).toContain("refresh the registry");
  });

  it("names an absent type nested inside a block, not just top-level ones", () => {
    const file = validFile();
    (file.body as { branches: unknown[] }[])[1]!.branches.push({ type: "api-call", id: uuid(22), name: "nested-call" });
    const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);
    expect(result.status).toBe("unregistered-types");
    if (result.status !== "unregistered-types") return;
    expect(result.absent.map((a) => a.type)).toContain("api-call");
  });

  it("stamps absent ids and flags idsStamped, opening the buffer (ADR 0015)", () => {
    const file = validFile();
    delete (file.body as Record<string, unknown>[])[0]!.id;
    delete file.id;
    const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);

    expect(result.status).toBe("opened");
    if (result.status !== "opened") return;
    expect(result.idsStamped).toBe(true);
    // The stamped ids are valid UUIDv4s in the parsed model.
    expect(result.file.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.file.body[0]!.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("refuses a file with duplicate ids, naming the colliding nodes", () => {
    const file = validFile();
    (file.body as Record<string, unknown>[])[1]!.id = uuid(2); // collide with node "draft"
    const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);

    expect(result.status).toBe("duplicate-ids");
    if (result.status !== "duplicate-ids") return;
    expect(result.message).toContain(uuid(2));
    expect(result.message).toContain('"draft"');
    expect(result.message).toContain('"fan"');
  });

  it("refuses a file with an invalid-format id, naming the node", () => {
    const file = validFile();
    (file.body as Record<string, unknown>[])[0]!.id = "not-a-uuid";
    const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);

    expect(result.status).toBe("invalid-ids");
    if (result.status !== "invalid-ids") return;
    expect(result.message).toContain('"draft"');
    expect(result.message).toContain("not-a-uuid");
  });

  it("checks portability before identity: an unregistered type wins over a duplicate id", () => {
    const file = validFile();
    (file.body as Record<string, unknown>[])[1]!.id = uuid(2); // a duplicate id …
    (file.body as unknown[]).push({ type: "api-call", id: uuid(30), name: "call-a" }); // … and an absent type
    const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);
    expect(result.status).toBe("unregistered-types");
  });

  it("reports a non-JSON body as invalid, not a crash", () => {
    const result = openWorkflowFile("{ not json", DEFAULT_PLUGINS);
    expect(result.status).toBe("invalid");
  });

  it("reports a superseded @2 format with the codemod remedy, via the schema parse", () => {
    const file = validFile();
    file.format = "path/workflow@2";
    const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.message).toContain("migrate-workflow-format-v3.ts");
  });
});
