import { describe, expect, it } from "vitest";
import {
  isTerminal,
  RUN_STATUSES,
  RunStatusSchema,
  TERMINAL_RUN_STATUSES,
  type RunStatus,
} from "../src/run-status.js";

/**
 * Terminality used to be written four times — in `@path/client-core`'s view-model, in the viewer's
 * `node-io` (a file that already imported from client-core), in the server's cancel route, and as
 * an inline parameter union in the engine's run store. This is the one definition (#66).
 */
describe("isTerminal", () => {
  it("is true for exactly the three statuses a run can end on", () => {
    const terminal = RUN_STATUSES.filter(isTerminal);
    expect(terminal).toEqual(["succeeded", "failed", "cancelled"]);
  });

  it("is false while a run has not ended", () => {
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });

  it("agrees with TERMINAL_RUN_STATUSES", () => {
    expect(RUN_STATUSES.filter(isTerminal)).toEqual([...TERMINAL_RUN_STATUSES]);
  });

  it("narrows the type, so a caller can hand the result to a terminal-only field", () => {
    const status: RunStatus = "cancelled";
    if (isTerminal(status)) {
      const terminal: (typeof TERMINAL_RUN_STATUSES)[number] = status; // compile-time assertion
      expect(terminal).toBe("cancelled");
    }
  });
});

describe("RUN_STATUSES", () => {
  it("is the set the schema validates against", () => {
    for (const status of RUN_STATUSES) expect(RunStatusSchema.parse(status)).toBe(status);
    expect(RunStatusSchema.safeParse("halfway").success).toBe(false);
  });
});
