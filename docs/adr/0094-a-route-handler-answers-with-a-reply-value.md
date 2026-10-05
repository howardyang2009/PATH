# A route handler answers with a reply value, not a response

**Status:** accepted.

Every `/v0` handler took the raw `IncomingMessage`/`ServerResponse` pair and wrote its own answer:
`sendError(res, …)` on a refusal, `res.writeHead(…); res.end(JSON.stringify(…))` on a success. The
shared body reader wrote its own `400` too. So a handler could not be exercised without a real
socket and a full `RouteContext`; the only test surface for a route was a running server, reached
over HTTP. Several routes had no test that named them at all.

## Decision

1. **A `reply` handler takes a decoded `ApiRequest` and returns a `RouteReply`.** The route table
   (`api-routes.ts`) is the only writer of a response: it sends `reply.status`, `reply.body` as
   JSON, and `reply.headers`.
2. **`readRequestBody` returns the `400` as a reply value**, beside the parsed body, so the
   parse/validate prologue has no side effect either.
3. **A `stream` handler takes a `StreamRequest` and owns the socket.** Only the four routes
   that cannot answer with a value are streams: the run event stream (SSE) and the three byte
   servers (workflow file read, workflow download, template download).
4. **`GET /v0/auth-config` is a reply too**, so the public route joins the same shape.

## Consequences

- A handler is driven directly with a decoded request: a body stream, the context, the params and
  the query. `test/route-reply.test.ts` does that with no server; `test/post-runs.test.ts` drops its
  response sink.
- The status mapping lives in the handler that knows the store's refusal, and the writing of it
  lives in one place.
- HTTP-level behavior is unchanged; the existing socket tests still cover it end to end.
