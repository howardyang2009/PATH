import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";

/**
 * The operator's **launch facts** (ADR 0046): the three things an operator may supply at launch
 * beyond the workflow file — an input override, a config override, and the launch worker-default
 * table — frozen on the run's root row so a re-entry of that run (Resume, Complete) can recover them
 * and so a reader can see what the run was launched with.
 *
 * They are a per-**tree** fact, not a per-node one, which is why they ride the root row and the
 * run-tree response rather than `RunRecord`. `input` and `workerDefaults` are recorded verbatim; the
 * input override is recorded but never re-applied on a continuation, because both Resume and Complete
 * restore the context blackboard rather than re-seeding from input (`run-workflow.ts`).
 *
 * `config` is stored **resolved and masked**: `$env` looked up and `$secret` unwrapped at launch
 * (ADR 0022 sub-4), then scrubbed by value at the observation seam, so a secret value reads as its
 * `[secret:<key>]` token. `secretKeys` names the dot-paths whose values were secrets, which is what
 * lets a continuation demand them again instead of replaying a token as if it were a credential.
 */
export interface LaunchFacts {
  /** The operator's override input seed, as supplied. Recorded and displayed; never re-applied. */
  input?: JsonValue;
  /** The operator's override config, `$env`-resolved and `$secret`-masked at the observation seam. */
  config?: ConfigObject;
  /** The frozen launch worker-default table (`{ <stepType>: <workerName> }`, ADR 0044). */
  workerDefaults?: { [stepType: string]: string };
  /** Dot-paths within `config` whose values were `$secret`-wrapped, stored masked. */
  secretKeys?: string[];
}
