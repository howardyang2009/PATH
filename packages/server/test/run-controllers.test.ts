import { describe, expect, it } from "vitest";
import { RunControllers } from "../src/run-controllers.js";

describe("RunControllers", () => {
  it("aborts a registered run's controller and reports that it did", () => {
    const controllers = new RunControllers();
    const controller = new AbortController();
    controllers.register("root-1", controller);

    expect(controllers.abort("root-1")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("reports false for an unregistered id, aborting nothing", () => {
    const controllers = new RunControllers();
    const controller = new AbortController();
    controllers.register("root-1", controller);

    expect(controllers.abort("root-2")).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("answers true again on a repeated abort — the second is a no-op, not a refusal", () => {
    const controllers = new RunControllers();
    controllers.register("root-1", new AbortController());

    expect(controllers.abort("root-1")).toBe(true);
    expect(controllers.abort("root-1")).toBe(true);
  });

  it("refuses to abort a deleted entry, and empties as its runs settle", () => {
    const controllers = new RunControllers();
    controllers.register("root-1", new AbortController());
    controllers.register("root-2", new AbortController());
    expect(controllers.size).toBe(2);

    controllers.delete("root-1");
    expect(controllers.abort("root-1")).toBe(false);
    expect(controllers.size).toBe(1);

    controllers.delete("root-2");
    expect(controllers.size).toBe(0);
    // Deleting an id that was never registered is harmless (a run that crashed before `runStarted`).
    controllers.delete("root-3");
    expect(controllers.size).toBe(0);
  });
});
