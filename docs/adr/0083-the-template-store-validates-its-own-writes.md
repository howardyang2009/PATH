# The template store validates its own writes

**Status:** accepted. Extends [ADR 0050](0050-the-template-api-is-id-addressed-and-owns-the-template-write-door.md).

The template store owned the write door, but `create` and `update` wrote any payload. Each route
validated the envelope itself, and `POST /v0/templates` never checked whether the envelope id was
already held: a colliding save-as returned 201, and the next scan flagged one entry invalid.

## Decision

1. **`create` and `update` validate the envelope** against the registry-relative schema the store
   built at discovery, and refuse with 400 and the issues.
2. **`create` refuses an id any template holds**, shipped or user, with 409 naming the holder.
3. **`update` refuses a body whose id differs from the addressed one** (400).
4. **The routes parse the request, call the store and reply.** The store's own tests drive every rule
   without HTTP.
