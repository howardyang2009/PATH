# The user id is the Clerk `sub`, verified on every request

**Status:** accepted. Gives [ADR 0084](0084-authored-files-live-in-shipped-shared-and-per-user-folders.md)
its real `<user-id>` in hosted mode.

## Context

Hosted mode signs users in with Clerk. The Server must turn each request into a PATH user id that
names a folder (`users/<user-id>/`), a store and the creator of shared items. A usual web app keeps a
user table and a session cache. PATH keeps its data in local SQLite on one host and wants no second
source of truth about who exists.

## Decision

1. **The user id is the Clerk `sub`, raw.** The Server checks it against `^user_[A-Za-z0-9]+$`
   before any path use and refuses `local` as a hosted id.
2. **Verified on every request, with no cache.** The Server calls `verifyToken` from
   `@clerk/backend` with `jwtKey` (no network call) and `authorizedParties` set to the exact public
   origin. The result lives on that request only.
3. **No user table.** PATH stores only `sub` values (folder names, creator rows). Display names come
   from Clerk in the client.
4. **Bearer token.** Clients send `Authorization: Bearer <token>` on every REST and SSE call. In
   hosted mode every `/v0/*` door answers `401` without a valid token, except `GET /v0/auth-config`
   and the health route.
5. **Fail closed.** Hosted mode is on when `CLERK_JWT_KEY` and `PATH_ALLOWED_ORIGIN` are set. A
   half-configured hosted setup refuses to start; it never falls back to `local`. Hosted mode also
   needs `CLERK_PUBLISHABLE_KEY`, which `GET /v0/auth-config` hands clients to sign in with, and
   refuses to start without it.
6. **The run VM sees no token.** The host stamps the launcher's id and mounts only that user's store.

## Considered options

- **A PATH user table** synced from Clerk webhooks: a second record of who exists, and webhooks need
  a public endpoint and retry handling.
- **A session cache** keyed by token: saves a local signature check that costs microseconds, and
  outlives a Clerk ban.
- **The `__session` cookie** instead of a Bearer header: one origin makes it work, but the SSE
  client and blob fetches then depend on cookie rules; one header is simpler to test.

## Consequences

- A Clerk development and production instance have separate user pools, so every `sub` changes at
  the move to production. The `path-server remap-user` tool moves each user's data (see the website
  spec).
- A Clerk ban takes effect within one token lifetime (60 s).
