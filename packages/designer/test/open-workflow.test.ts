import { DEFAULT_PLUGINS } from "@path/client-core/test-utils";
import { loadMessages, renderMessage } from "@path/i18n";
import { FORMAT_VERSION } from "@path/schema";
import { createTranslator } from "use-intl/core";
import { describe, expect, it } from "vitest";
import { openWorkflowFile } from "../src/open-workflow.js";

/** A distinct valid UUIDv4 per seed, so fixtures read as ids without a random source. */
function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

/** A whole valid `@3` file exercising every block shape, each node with a valid id and a unique
 * name. */
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
        arms: [
          {
            when: { type: "exists", path: "context.x" },
            node: { type: "prompt", id: uuid(7), name: "arm-a", prompt: "a" },
          },
        ],
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
          body: [
            {
              type: "checkpoint",
              id: uuid(11),
              name: "chk",
              condition: { type: "exists", path: "previous.z" },
            },
          ],
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
      { type: "api-call", folder: "packages/engine/plugin/step-plugin/api-call/" },
      { type: "grpc", folder: "packages/engine/plugin/step-plugin/grpc/" },
    ]);
    expect(result.message).toEqual({
      key: "designer.openWorkflow.unregisteredTypes",
      params: { count: 2 },
    });
    expect(result.details).toEqual([
      {
        key: "designer.openWorkflow.unregisteredType",
        params: { type: "api-call", folder: "packages/engine/plugin/step-plugin/api-call/" },
      },
      {
        key: "designer.openWorkflow.unregisteredType",
        params: { type: "grpc", folder: "packages/engine/plugin/step-plugin/grpc/" },
      },
      { key: "designer.openWorkflow.unregisteredRetry" },
    ]);
  });

  it("names an absent type nested inside a block, not just top-level ones", () => {
    const file = validFile();
    (file.body as { branches: unknown[] }[])[1]!.branches.push({
      type: "api-call",
      id: uuid(22),
      name: "nested-call",
    });
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
    const named = (name: string) => ({ key: "designer.openWorkflow.nodeNamed", params: { name } });
    expect(result.message).toEqual({
      key: "designer.openWorkflow.duplicateIds",
      params: { count: 1 },
    });
    expect(result.details).toEqual([
      {
        key: "designer.openWorkflow.duplicateId",
        params: {
          id: JSON.stringify(uuid(2)),
          nodes: {
            key: "designer.openWorkflow.nodeList",
            params: { first: named("draft"), rest: named("fan") },
          },
        },
      },
    ]);
  });

  it("refuses a file with an invalid-format id, naming the node", () => {
    const file = validFile();
    (file.body as Record<string, unknown>[])[0]!.id = "not-a-uuid";
    const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);

    expect(result.status).toBe("invalid-ids");
    if (result.status !== "invalid-ids") return;
    expect(result.message).toEqual({
      key: "designer.openWorkflow.invalidIds",
      params: { count: 1 },
    });
    expect(result.details).toEqual([
      {
        key: "designer.openWorkflow.invalidId",
        params: {
          node: { key: "designer.openWorkflow.nodeNamed", params: { name: "draft" } },
          value: '"not-a-uuid"',
        },
      },
    ]);
  });

  it("checks portability before identity: an unregistered type wins over a duplicate id", () => {
    const file = validFile();
    (file.body as Record<string, unknown>[])[1]!.id = uuid(2); // a duplicate id …
    // … and an absent type
    (file.body as unknown[]).push({ type: "api-call", id: uuid(30), name: "call-a" });
    const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);
    expect(result.status).toBe("unregistered-types");
  });

  it("reports a non-JSON body as invalid, not a crash", () => {
    const result = openWorkflowFile("{ not json", DEFAULT_PLUGINS);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.message).toEqual({
      key: "designer.openWorkflow.notJson",
      params: { error: expect.any(String) },
    });
    expect(result.details).toEqual([]);
  });

  it("reports a superseded @2 format with the codemod remedy, via the schema parse", () => {
    const file = validFile();
    file.format = "path/workflow@2";
    const result = openWorkflowFile(JSON.stringify(file), DEFAULT_PLUGINS);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.message).toEqual({ key: "designer.openWorkflow.notValid" });
    expect(result.details).toContainEqual({
      key: "errors.schema.format.superseded",
      params: expect.objectContaining({
        format: "path/workflow@2",
        codemods: expect.stringContaining("scripts/archive/migrate-workflow-format-v3.ts"),
      }),
    });
  });
});

describe("openWorkflowFile refusals in en", () => {
  async function english(result: ReturnType<typeof openWorkflowFile>): Promise<string> {
    if (result.status === "opened") throw new Error("expected a refusal");
    const t = createTranslator({ locale: "en", messages: await loadMessages("en") });
    return [result.message, ...result.details].map((m) => renderMessage(t, m)).join("\n");
  }

  it("reads an absent type and a duplicate id as before", async () => {
    const absent = validFile();
    (absent.body as unknown[]).push({ type: "grpc", id: uuid(21), name: "call-b" });
    expect(await english(openWorkflowFile(JSON.stringify(absent), DEFAULT_PLUGINS))).toBe(
      [
        "Cannot open: this file names 1 step type absent from the server's registry.",
        '  • "grpc" — add packages/engine/plugin/step-plugin/grpc/ to this PATH tree',
        "If the server has since loaded these plugins, refresh the registry and retry.",
      ].join("\n"),
    );

    const duplicate = validFile();
    (duplicate.body as Record<string, unknown>[])[1]!.id = uuid(2);
    expect(await english(openWorkflowFile(JSON.stringify(duplicate), DEFAULT_PLUGINS))).toBe(
      [
        "Cannot open: 1 node id is used more than once.",
        `  • id "${uuid(2)}" is shared by "draft", "fan"`,
      ].join("\n"),
    );
  });
});
