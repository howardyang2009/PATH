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
    // No assignee on the node — the park echoes none (#488).
    expect(result).toEqual({ status: "awaiting", assignee: undefined });
  });

  it("echoes the node's assignee on the awaiting result (#488)", async () => {
    const request = {
      fields: { description: "Approve the PR", assignee: "alex" },
      input: {},
      config: {},
      cwd: "/tmp",
      signal: new AbortController().signal,
    } as unknown as PersonRequest;

    const result = await stepPlugin.workers.person!.run(request);
    // The interpolated assignee rides the park so the engine can put it on the `step-awaiting` record.
    expect(result).toEqual({ status: "awaiting", assignee: "alex" });
  });

  it("declares assignee as an optional field", () => {
    expect(stepPlugin.fields.assignee).toBeDefined();
  });

  it("declares description as a required field", () => {
    expect(stepPlugin.fields.description).toBeDefined();
  });
});
