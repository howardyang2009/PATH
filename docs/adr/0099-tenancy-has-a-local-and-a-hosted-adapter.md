# Tenancy has a local and a hosted adapter

**Status:** accepted. Restructures, and does not change, the behaviour of
[ADR 0088](0088-each-request-sees-its-own-view-and-only-the-creator-writes-a-shared-item.md) to
[ADR 0091](0091-a-hosted-run-executes-in-one-vm-per-engine-invocation.md).

The requester contexts took six independent hosted options (`hosted`, `resolveUserId`, `secretsKey`,
`previousSecretsKey`, `sandbox`, `runOwner`). The type allowed illegal combinations, so the module
re-checked them at runtime, and `create-server.ts` branched on the mode in seven places.
`startPathServer` took eight positional parameters.

## Decision

1. **A `Tenancy` (`packages/server/src/tenancy.ts`) answers who a request acts for and opens each
   user's store, runs and Secret store.** `localTenancy` and `hostedTenancy` are its two adapters; a
   hosted tenancy cannot be built without a sandbox or a secrets key.
2. **The requester contexts only cache one context per user** over the tenancy.
3. **The Server branches on the mode once**, in `tenantsOf`, which composes admission and tenancy.
4. **`startPathServer(projectDir, options)` takes an options object.**

## Consequences

- The runtime refusal of in-process runs in hosted mode is gone: the type now forbids it.
