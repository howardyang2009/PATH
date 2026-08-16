import { mapEnv, type ConfigObject, type JsonValue } from "@path/schema";

/**
 * The `$env` reject that every endpoint taking operator-supplied override config owes ADR 0012:
 * `POST /v0/runs` (§2) and `POST /v0/runs/:root_run_id/resume` (§4.3). A browser operator may name a
 * literal `{"$secret": "..."}` but not `{"$env": "NAME"}` — an `$env` would source a config value
 * from the *server process* environment and read it back through a step's output. `ConfigObjectSchema`
 * is shared with workflow-authored config (where `$env` is legitimate), so the reject can't live in
 * the schema; it is this post-parse walk on the operator path only.
 *
 * Returns a ready-to-send `400` message naming every offending dot-path, or `undefined` when the
 * config is clean. `mapEnv` descends *through* a `$secret` wrapper, so the composed
 * `{"$secret": {"$env": "NAME"}}` form is caught and reported at the config key (not `key.$secret`).
 */
export function operatorConfigEnvError(config: ConfigObject): string | undefined {
  const paths: string[] = [];
  mapEnv(config as JsonValue, (_name, path) => {
    paths.push(path);
    return null;
  });
  if (paths.length === 0) return undefined;
  return `operator config may not source from the server environment: $env at ${paths.map((p) => `"${p}"`).join(", ")}`;
}
