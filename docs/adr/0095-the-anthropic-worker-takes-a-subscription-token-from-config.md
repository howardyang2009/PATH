# The `anthropic` worker takes a subscription token from config

**Status:** accepted. Extends [ADR 0045](0045-deepseek-credential-config-first-environment-fallback.md)'s
config-first credential rule to the `anthropic` worker.

## Context

The `anthropic` worker left auth to the Agent SDK, which reads `ANTHROPIC_API_KEY` or a subscription
credential from the process environment. A sandboxed run's VM has no Keychain and no host
environment ([ADR 0089](0089-in-hosted-mode-the-launchers-secret-store-replaces-the-host-environment.md)),
so the only way to run on a Claude subscription was a `CLAUDE_CODE_OAUTH_TOKEN` User secret. An
operator could not choose a subscription per run. Putting the token in `config.options.env` does not
work: the SDK's `env` replaces the subprocess environment, and an operator's `options` replaces the
file's whole `options` under the shallow merge.

## Decision

1. **`config.CLAUDE_CODE_OAUTH_TOKEN` is the `anthropic` worker's credential key.** It is ordinary
   config: inheritable, operator-overridable at launch, and masked when wrapped in `$secret`.
2. **A non-empty value wins.** The worker passes the SDK `env` = `process.env` plus
   `CLAUDE_CODE_OAUTH_TOKEN`, with `ANTHROPIC_API_KEY` removed, because the SDK prefers an API key
   over the token. The engine sets `env` after the `options` bag, so `options.env` cannot override it.
3. **Absent or empty means unchanged.** The worker passes no `env`, and the SDK reads its own
   environment as before.
4. **`deepseek` ignores the key**, as `anthropic` ignores `DEEPSEEK_API_KEY`.

## Consequences

- An operator launches with `{"CLAUDE_CODE_OAUTH_TOKEN": {"$secret": "sk-ant-oat01-..."}}` (from
  `claude setup-token`), and every `anthropic` step in the tree uses that subscription.
- A literal `$secret` must be supplied again on a Resume or a Complete (ADR 0089 §8). An author who
  wants it sourced writes `{"$secret": {"$env": "CLAUDE_CODE_OAUTH_TOKEN"}}`.
- Without `$secret` the token is a plain value that the masker does not know about.
