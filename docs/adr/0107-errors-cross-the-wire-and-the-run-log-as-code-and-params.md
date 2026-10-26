# Errors cross the wire and the run log as a code and params

**Status:** accepted. Part of the translation map ([#795](https://github.com/howardyang2009/PATH/issues/795)), resolved in [#803](https://github.com/howardyang2009/PATH/issues/803).

## Context

PATH is translated into German, English and Chinese. About 270 server, engine and schema messages
reach the UI. Today they are English prose: refusals come as `{ error: { message, details } }`, and the
engine writes English prose into `step-finished.error` in `log_events`, so English is stored, not
only shown. The store has no migration framework before 1.0: a `user_version` mismatch refuses to
open the db.

## Decision

1. **The client localizes.** A message PATH owns crosses the wire as a stable **error code** plus
   `params`. The client renders it from its catalogue in the viewer's language. The server and the
   store stay language-neutral.
2. **Wire shape.** `{ error: { code, params, message, details } }`. `message` stays English: it is the
   fallback for an old client, `curl` and an unknown code.
3. **Codes are catalogue keys.** A code is dotted kebab-case (`run.resume.illegal-k`). Its message is
   `errors.<code>` in each catalogue. There is no mapping table.
4. **New run events carry the code.** The engine writes `error_code` and `error_params` next to the
   English `error`. They live in the event JSON, so the db schema version does not change.
5. **Old events are matched at read time.** When an event has no `error_code`, the server matches its
   `error` against patterns generated from the English catalogue. Each ICU template becomes a regex
   whose captures are the params. The db is not rewritten. Text that matches no pattern is shown as
   stored.
6. **Text PATH does not own is never translated.** A worker's stderr, an exception from user code or
   an external API body is shown verbatim. Only the wrapper label around it is translated.
7. **zod issues travel as zod issue codes.** The client renders built-in issues with zod's own `de` /
   `zh-CN` locale. PATH's own validation messages get codes like every other message.
8. **Operator text stays English.** The CLI, server logs and stderr are not translated.

## Considered options

- **The server localizes from the cookie or `Accept-Language`**: one stored run would read in one
  language only, and the catalogues would live on both sides.
- **Rewrite old rows in place**: needs a backup and either a first migration framework or a one-off
  command run against every local db. Matching at read time gets the same result and writes nothing.
- **A hand-written table of old-message regexes**: a second source of truth that drifts from the
  catalogue.

## Consequences

- A test proves every code's English template round-trips through its generated regex.
- An old message whose wording changed before codes existed does not match, and stays English.
- Serving an old error costs one regex pass. A new event costs nothing extra.
