import { describe, expect, it } from "vitest";
import { stepPlugin } from "../step-plugins/person-activity/index.js";

type ManualRequest = Parameters<NonNullable<typeof stepPlugin.workers.manual>["run"]>[0];

describe("person-activity plugin", () => {
  it("has a manual worker as the default", () => {
    expect(stepPlugin.defaultWorker).toBe("manual");
    expect(stepPlugin.workers.manual).toBeDefined();
  });

  it("does not meter and does not need a processor slot", () => {
    expect(stepPlugin.workers.manual!.meters).toBe(false);
    expect(stepPlugin.workers.manual!.needsProcessorSlot).toBe(false);
  });

  it("returns awaiting from the manual worker", async () => {
    const request = {
      fields: { description: "Approve the PR" },
      input: {},
      config: {},
      cwd: "/tmp",
      signal: new AbortController().signal,
    } as unknown as ManualRequest;

    const result = await stepPlugin.workers.manual!.run(request);
    expect(result).toEqual({ status: "awaiting" });
  });

  it("declares description as a required field", () => {
    expect(stepPlugin.fields.description).toBeDefined();
  });
});
