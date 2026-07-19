import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fakeIo() {
  return { log: vi.fn(), error: vi.fn() };
}

describe("cli main()", () => {
  it("runs a valid workflow and prints its final output", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "two-binary-steps.workflow.json")], io);
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith("HELLO");
    expect(io.error).not.toHaveBeenCalled();
  });

  it("exits non-zero and reports load-time errors without running anything", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "invalid-schema.workflow.json")], io);
    expect(code).toBe(1);
    expect(io.error.mock.calls.join("\n")).toMatch(/bogus_field/);
    expect(io.log).not.toHaveBeenCalled();
  });

  it("exits non-zero and reports a ref cycle before running anything", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "cycle-a.workflow.json")], io);
    expect(code).toBe(1);
    expect(io.error.mock.calls.join("\n")).toMatch(/cycle/i);
  });

  it("exits non-zero when a step fails", async () => {
    const io = fakeIo();
    const code = await main(["run", join(fixtures, "failing-step.workflow.json")], io);
    expect(code).toBe(1);
    expect(io.error.mock.calls.join("\n")).toMatch(/run failed/);
  });

  it("prints usage and exits non-zero for a missing workflow path", async () => {
    const io = fakeIo();
    const code = await main(["run"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/usage/i));
  });
});
