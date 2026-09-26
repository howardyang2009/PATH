import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";

/** The operator's launch facts (ADR 0046): `input`, `config` (stored `$env`-resolved and `$secret`-masked)
 * and `workerDefaults`, frozen on the run's root row. `input` is recorded, never re-applied on a continuation. */
export interface LaunchFacts {
  input?: JsonValue;
  config?: ConfigObject;
  workerDefaults?: { [stepType: string]: string };
  secretKeys?: string[];
}
