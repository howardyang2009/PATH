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
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ shouted: "HELLO" }));
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

describe("cli main() — operator config flags (ticket #17)", () => {
  const configEcho = join(fixtures, "config-echo.workflow.json");

  it("uses the file's config default with no flags", async () => {
    const io = fakeIo();
    const code = await main(["run", configEcho], io);
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "file-default" }));
  });

  it("--set overrides the file default, nearest wins", async () => {
    const io = fakeIo();
    const code = await main(["run", configEcho, "--set", "greeting=operator-value"], io);
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "operator-value" }));
  });

  it("--config loads a whole object that overrides the file default", async () => {
    const io = fakeIo();
    const code = await main(
      ["run", configEcho, "--config", join(fixtures, "config-override.json")],
      io,
    );
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "config-file-value" }));
  });

  it("--set wins over --config when both touch the same key", async () => {
    const io = fakeIo();
    const code = await main(
      ["run", configEcho, "--config", join(fixtures, "config-override.json"), "--set", "greeting=set-value"],
      io,
    );
    expect(code).toBe(0);
    expect(io.log).toHaveBeenCalledWith(JSON.stringify({ seen: "set-value" }));
  });

  it("reports a clear error for a malformed --set argument", async () => {
    const io = fakeIo();
    const code = await main(["run", configEcho, "--set", "no-equals-sign"], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--set/));
  });

  it("reports a clear error when --config points at a missing file", async () => {
    const io = fakeIo();
    const code = await main(["run", configEcho, "--config", join(fixtures, "nope.json")], io);
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/--config/));
  });
});
