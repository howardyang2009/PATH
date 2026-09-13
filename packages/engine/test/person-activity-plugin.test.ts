import { describe, expect, it } from "vitest";
import { stepPlugin } from "../step-plugins/person-activity/index.js";

type PersonRequest = Parameters<NonNullable<typeof stepPlugin.workers.person>["run"]>[0];

describe("person-activity plugin", () => {
  it("has a person worker as the default", () => {
    expect(stepPlugin.defaultWorker).toBe("person");
    expect(stepPlugin.workers.person).toBeDefined();
  });

  it("does not meter and does not need a processor slot", () => {
    expect(stepPlugin.workers.person!.meters).toBe(false);
    expect(stepPlugin.workers.person!.needsProcessorSlot).toBe(false);
  });

  it("returns awaiting from the person worker", async () => {
    const request = {
      fields: { description: "Approve the PR" },
      input: {},
      config: {},
      cwd: "/tmp",
      signal: new AbortController().signal,
    } as unknown as PersonRequest;

    const result = await stepPlugin.workers.person!.run(request);
    expect(result).toEqual({ status: "awaiting" });
  });

  it("declares description as a required field", () => {
    expect(stepPlugin.fields.description).toBeDefined();
  });
});
