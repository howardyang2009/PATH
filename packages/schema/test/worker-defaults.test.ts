import { describe, expect, it } from "vitest";
import { validateLaunchWorkerDefaults } from "../src/worker-defaults.js";
import { builtinRegistry } from "./builtin-registry.js";

// The launch channel of ADR 0044's two-channel registry-relative validation (#518). The operator's
// launch worker-default table (CLI `--worker-default`, server `worker_defaults`) is checked against the
// run's one registry at the launch boundary — the same taxonomy as the file channel, a different site,
// because the operator authored it in no file. The two launch surfaces prefix their own source onto
// these bare messages; here the registry-relative core is pinned on its own, over the built-in
// `binary` (ships `spawn`) / `prompt` (ships `anthropic`) registry fixture.
describe("validateLaunchWorkerDefaults (ADR 0044, #518)", () => {
  it("returns no errors for an undefined table (a flagless launch)", () => {
    expect(validateLaunchWorkerDefaults(undefined, builtinRegistry)).toEqual([]);
  });

  it("returns no errors for a table naming real types and workers they ship", () => {
    expect(
      validateLaunchWorkerDefaults({ binary: "spawn", prompt: "anthropic" }, builtinRegistry),
    ).toEqual([]);
  });

  it("flags an absent step type, naming the type and the installed list", () => {
    const errors = validateLaunchWorkerDefaults({ nope: "spawn" }, builtinRegistry);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/unknown step type "nope"/);
    // The installed list, the unknown-`type` node-error shape.
    expect(errors[0]).toMatch(/binary/);
    expect(errors[0]).toMatch(/prompt/);
  });

  it("flags a worker the type does not ship, listing the type's shipped names", () => {
    const errors = validateLaunchWorkerDefaults({ prompt: "nosuchworker" }, builtinRegistry);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/unknown worker "nosuchworker"/);
    expect(errors[0]).toMatch(/"prompt" ships "anthropic"/);
  });

  it("aggregates every bad entry in one pass", () => {
    const errors = validateLaunchWorkerDefaults(
      { nope: "spawn", prompt: "nosuchworker" },
      builtinRegistry,
    );
    expect(errors).toHaveLength(2);
    const joined = errors.join("\n");
    expect(joined).toMatch(/unknown step type "nope"/);
    expect(joined).toMatch(/unknown worker "nosuchworker"/);
  });
});
