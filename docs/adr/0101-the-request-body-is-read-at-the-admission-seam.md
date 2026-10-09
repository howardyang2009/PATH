# The request body is read at the admission seam

**Status:** accepted.

A request's body used to be read in two places. Hosted `Admission.admitRequest` buffered it under
the user's `maxBodyBytes` and stashed the bytes in a module-level `WeakMap` inside `http-json.ts`;
the route handler later pulled those bytes back out of the `WeakMap` and parsed them. Local mode's
`UNLIMITED_ADMISSION.admitRequest` was a no-op, so nothing capped the body and `readJsonBody` fell
through a second, uncapped reader. The bytes' lifetime was therefore a side-channel contract spread
over three modules, and a handler could not tell from its own signature whether the body had already
been read.

## Decision

1. **`Admission.admitRequest` reads the body.** It returns an `AdmissionResult`: the requester's
   `RequestBody` as a value, or the `429`/`413` refusal. `request-body.ts` owns the read, the cap,
   the JSON parse and the `413`/`400` wording; `admission.ts` owns the cap's value, which is
   `limits.forUser(userId).maxBodyBytes` in hosted mode and `DEFAULT_LIMITS.maxBodyBytes` in local
   mode.
2. **A handler receives the body; it never touches the stream.** `ApiRequest` carries `body`, and
   `readRequestBody(body, schema)` in `http-json.ts` is a pure schema check over that value. The
   `WeakMap`, `bufferRequestBody`, `readJsonBody` and the uncapped fallback reader are deleted.
3. **The cap holds in both modes.** Local mode keeps no rate, storage or VM limit, but its request
   body is read under the same default cap, so a request's shape does not change with the mode.

## Consequences

- An invalid JSON body is refused during admission, before any route handler runs; a handler's
  schema refusal keeps the `400` it always had.
- The body cap is testable in-process: admission takes an `IncomingMessage`-shaped fake, so the cap
  no longer needs a socket to exercise.
- `request-body.ts` is the one place a future streaming or multipart body would be read.
