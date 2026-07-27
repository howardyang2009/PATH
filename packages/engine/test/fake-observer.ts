import { type Mock, vi } from "vitest";
import type { Observation, RunObserver } from "../src/run-observer.js";

/**
 * Every `Observation` type, checked against the union at compile time. `OBSERVATION_TYPES` is what
 * makes the fake below total: it is built by mapping this list, so a member added to `Observation`
 * without being added here fails to compile rather than going unrecorded.
 *
 * That property is the point (#62). The double this replaced listed six hooks by hand — the same six
 * the masking wrapper happened to implement — so the test could not have caught the eight it dropped.
 */
export const OBSERVATION_TYPES = [
  "run-started",
  "step-started",
  "step-stderr",
  "step-usage",
  "step-finished",
  "context-changed",
  "join-applied",
  "run-cancelled",
  "run-finished",
  "checkpoint-evaluated",
  "branch-taken",
  "branch-no-match",
  "iteration-started",
  "loop-exited",
] as const satisfies readonly Observation["type"][];

// Fails to compile if the union grows a member the list above is missing.
type _Exhaustive = Exclude<Observation["type"], (typeof OBSERVATION_TYPES)[number]> extends never
  ? true
  : ["OBSERVATION_TYPES is missing", Exclude<Observation["type"], (typeof OBSERVATION_TYPES)[number]>];

/** The payload of one observation type, minus the discriminant. */
type PayloadOf<K extends Observation["type"]> = Omit<Extract<Observation, { type: K }>, "type">;

export type FakeObserver = RunObserver & {
  [K in Observation["type"]]: Mock<(payload: PayloadOf<K>) => void>;
} & {
  /** Every observation in arrival order, discriminants intact. */
  all: () => Observation[];
};

/**
 * A `RunObserver` that records through the real seam and fans each observation out to a per-type
 * mock, so a test can assert on `observer["step-finished"]` with the payload alone.
 */
export function fakeObserver(): FakeObserver {
  const all: Observation[] = [];
  const mocks = Object.fromEntries(OBSERVATION_TYPES.map((type) => [type, vi.fn()])) as {
    [K in Observation["type"]]: Mock<(payload: PayloadOf<K>) => void>;
  };
  return {
    ...mocks,
    all: () => all,
    observe(o: Observation) {
      all.push(o);
      const { type, ...payload } = o;
      (mocks[type] as Mock)(payload);
    },
  };
}
