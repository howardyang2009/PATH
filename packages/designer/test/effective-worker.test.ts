import type { WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import { fileWorkers } from "../src/effective-worker.js";

const plugins: WireStepPlugin[] = [
  { name: "prompt", fields: {}, workers: ["anthropic", "deepseek"], default_worker: "anthropic" },
  { name: "binary", fields: {}, workers: ["spawn"], default_worker: "spawn" },
];

function file(workerDefaults?: { [type: string]: string }): WorkflowFile {
  return {
    id: "f",
    name: "f",
    worker_defaults: workerDefaults,
    body: [
      { id: "a", name: "a", type: "prompt", prompt: "hi" },
      { id: "b", name: "b", type: "binary", command: "true" },
    ],
  } as unknown as WorkflowFile;
}

describe("fileWorkers", () => {
  it("reads each step's worker from the type default", () => {
    expect(fileWorkers(file(), plugins)).toEqual(["anthropic", "spawn"]);
  });

  it("follows the file's worker defaults", () => {
    expect(fileWorkers(file({ prompt: "deepseek" }), plugins)).toEqual(["deepseek", "spawn"]);
  });
});
