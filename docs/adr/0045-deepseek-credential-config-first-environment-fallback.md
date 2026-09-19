# The `deepseek` worker's credential is config first, environment second

**Status:** accepted; amends [ADR 0020](0020-plugin-masking-is-inherited-and-a-plugin-is-engine-trust.md)
sub-decision 9 for the shipped `prompt` workers.

The `deepseek` worker shipped reading `process.env.DEEPSEEK_API_KEY`
([`deepseek-worker.ts`](../../packages/engine/step-plugins/prompt/deepseek-worker.ts)), and ADR 0020
sub-decision 9 says a worker must not read `process.env`: "the engine's `$env` resolution is the only
env door." The `anthropic` worker bends the same rule through the Agent SDK, which reads
`ANTHROPIC_API_KEY` (or the subscription credential) itself. So the rule was already joined by both
shipped `prompt` workers without a record of the bend, and the operator who launches a discovered
workflow had no way to supply a key without reaching the server's environment and restarting it.

Decision: **the `deepseek` credential is read from `config.DEEPSEEK_API_KEY` first and
`process.env.DEEPSEEK_API_KEY` second.** Config is the primary door because the operator's launch
config (`POST /v0/runs`'s `config`, the Viewer's `Override config`) can carry a literal
`{"$secret": "…"}` — the channel ADR 0012 already sanctions — and because a `$secret`-wrapped config
value is the one the masker collects. The environment stays as the fallback a deployment-level key
already used. The rule is amended here, not quietly bent again: for a shipped `prompt` worker, a
provider credential may come from the environment when no config value names one.

## Decision, in parts

1. **Config wins, environment falls back.** One precedence, stated in one place: a non-empty
   `config.DEEPSEEK_API_KEY` is used; otherwise `process.env.DEEPSEEK_API_KEY`. An empty string counts
   as unset in both, so a config key that resolved empty (an `$env` naming an empty variable) falls
   through rather than sending an empty bearer token.
2. **Only the credential gains a config door.** `DEEPSEEK_BASE_URL` stays environment-only: a gateway
   address is deployment topology, not a per-run credential, and it is not secret.
3. **The key is named after the variable it falls back to.** `DEEPSEEK_API_KEY`, not a generic
   `api_key`. Config is type-scoped and shared by both `prompt` workers, so a generic name would be
   silently ignored by `anthropic` — a false promise. Naming it after the variable makes the
   precedence pair read as one thing.
4. **The value must be `$secret`-wrapped to be masked.** `$secret`/`$env` resolution runs before
   run-start config validation, so the fragment's `z.string()` checks the resolved literal, and
   `collectSecrets` collects the value from the operator config. A plain string is a real value
   carried into the run that no masker knows about.
5. **The `$env` reject on operator config is unchanged.** ADR 0012's reasoning — a browser operator
   must not name a server variable and read it back — still holds. A browser operator can type a
   literal `$secret`; it cannot make the server resolve `$env` on its behalf.

## Considered options

- **Keep environment-only (status quo).** Rejected: it leaves the ADR 0020 sub-9 violation on the
  record with no decision behind it, and rotating a key means restarting the server — the exact cost
  the launch config door exists to remove.
- **Config only; delete the environment read.** The strictest reading, and the one that would make
  ADR 0020 sub-9 true again for this worker. Rejected *here*, not refused: it breaks every deployment
  that exports `DEEPSEEK_API_KEY` today, and every workflow would have to declare
  `{"$secret": {"$env": "DEEPSEEK_API_KEY"}}` to keep working. Revisit if the fallback proves to be
  the confusing door rather than the convenient one.
- **Give `anthropic` a config credential key too.** Out of scope: its path is the Agent SDK's
  (API key or subscription), and rewiring it is its own change with its own compat surface.
- **A generic `api_key` config key for both workers.** Rejected in sub-decision 3: the name would
  promise something `anthropic` does not honor.
- **Also put `DEEPSEEK_BASE_URL` in config.** Rejected in sub-decision 2.

## Consequences

- The `prompt` type's config fragment gains an optional `DEEPSEEK_API_KEY`; run-start validation
  accepts it as the resolved string. Config is `.passthrough()`, so no other type is affected.
- **A workflow file may now hold the key**, as
  `{"DEEPSEEK_API_KEY": {"$secret": {"$env": "DEEPSEEK_API_KEY"}}}` — env-sourced and masked — which
  is why `workflow-format-v3.md` §4.2 and §7.1 no longer say the credential is environment-only.
- **The environment read stays, and the rule it bends is now recorded.** ADR 0020 sub-decision 9
  gains a cross-reference line, the way it added one to ADR 0012.
- **CONTEXT.md's *Worker* entry narrows.** "Never `process.env` directly" becomes a rule with this
  recorded exception for a provider credential.
- **An unwrapped config key is not masked.** Docs say so at both the config key and the format
  section; the masker's by-value design is unchanged.
