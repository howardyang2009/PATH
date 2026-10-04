# In hosted mode, the launcher's Secret store replaces the host environment

**Status:** accepted. Amends [ADR 0012](0012-operator-config-rejects-env-wrapper.md) and
[ADR 0045](0045-deepseek-credential-config-first-environment-fallback.md) for hosted mode. Local mode
is unchanged.

## Context

Each user of the hosted website brings their own keys. Today `$env` resolves against the Server's
process environment, the `deepseek` worker falls back to `process.env.DEEPSEEK_API_KEY`, and the
Agent SDK reads `ANTHROPIC_API_KEY` itself. On a shared host that means any signed-in user can author
`{"$env": "SOME_HOST_VAR"}` and echo the owner's variable, and every user spends the owner's
provider credentials. A hosted root run executes in one VM per engine invocation, and a user's data
lives in their own store at `users/<user-id>/.path/`.

## Decision

1. **Each user has a Secret store of User secrets.** A User secret is a name and a value. In hosted
   mode the launcher's Secret store is the environment that `{"$env": "NAME"}` resolves against.
   Authored workflows do not change.
2. **The host environment is never a fallback in hosted mode.** No `$env`, no prompt-worker
   fallback and no SDK read sees a host variable. An unset name fails the run before its first step,
   as today.
3. **Storage.** User secrets are rows in the user's own `path.db`, encrypted with AES-256-GCM under a
   host master key from `PATH_SECRETS_KEY`. Each row records a key id so that rotation can come later
   without a migration. Hosted mode fails closed without the master key.
4. **Write-only API.** `PUT /v0/secrets/:name` sets or replaces, `GET /v0/secrets` lists names and
   `updated_at` only, `DELETE /v0/secrets/:name` removes. No door returns a value. In local mode the
   doors answer `404`.
5. **The VM gets the launcher's whole Secret store as its environment.** The engine inside the VM
   resolves `$env` as it does today. The VM environment carries no host variable except an explicit
   allowlist (such as `DEEPSEEK_BASE_URL`).
6. **Every User secret is masked.** In hosted mode the engine adds every Secret-store value to the
   masker, so a plain `$env` without `$secret` is still masked. The token is `[secret:<name>]`.
7. **The launcher's store, always.** A non-creator who runs a shared workflow uses their own Secret
   store, never the creator's.
8. **A continuation resolves again.** A Resume or a Complete reads the launcher's store as it is at
   continuation time. A rotated key gives the new value; a deleted name fails before the first step.
   A literal `$secret` in operator config must still be supplied again.
9. **Precedence stays ADR 0045's.** A non-empty `config.DEEPSEEK_API_KEY` wins, then the Secret
   store. Operator config still rejects `$env`.
10. **Limits.** Names match `^[A-Z_][A-Z0-9_]*$`, at most 128 characters. Values are at most 64 KiB.
    At most 100 User secrets per user. Reserved names answer `400`: `PATH`, `HOME`, `USER`, `SHELL`,
    `TMPDIR`, `NODE_*`, `LD_*`, `DYLD_*`, `PATH_*`, and the host allowlist names.

## Considered options

- **A new `$user` wrapper beside `$env`.** Every workflow would need two forms for local and hosted
  mode.
- **Host environment as fallback.** It leaks the owner's variables and credentials to every user.
- **macOS Keychain or Clerk private metadata.** A second backend beside the per-user store, and
  Clerk would hold provider keys.
- **Inject only the names the tree references.** The host would have to predict which variables a
  worker or the SDK reads.

## Consequences

- Losing `PATH_SECRETS_KEY` loses every User secret; users enter them again. Key backup and a
  rotation tool are part of the backup and recovery decision.
- Each hosted user must store their own provider key before a `prompt` step can run.
