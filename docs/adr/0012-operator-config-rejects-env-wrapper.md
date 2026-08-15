# Operator-supplied config rejects `$env`; literal `$secret` still allowed

**Status:** accepted; reverses the `$env`-in-posted-config stance argued in
[server-api-spec.md §2](../spec/server-api-spec.md) and pins the "operator may override config"
security fork charted in [#228](https://github.com/howardyang2009/PATH/issues/228).

The viewer launches a discovered workflow from the browser with operator-supplied `input` + `config`
([#228](https://github.com/howardyang2009/PATH/issues/228)). Operator config reaches the engine
through `POST /v0/runs` (`RunOptions.operatorConfig`). The question ([#231](https://github.com/howardyang2009/PATH/issues/231)):
what may that config carry — specifically the `{"$secret": ...}` and `{"$env": "NAME"}` wrappers
(CONTEXT.md → Data, workflow-format §8.3)?

Decision: **operator-supplied override config accepts a literal `{"$secret": "..."}`, and rejects
any `{"$env": "NAME"}` wrapper — including the composed `{"$secret": {"$env": "NAME"}}` form — with a
`400`.** The reject is uniform across every caller of `POST /v0/runs` (a browser `fetch` and a
`curl` are indistinguishable to one no-auth same-origin endpoint), and it applies **only to
operator-supplied override config**: a `$env` wrapper authored *inside* a `workflow.json` is
untouched — the engine still resolves it against the server process at run start.

Why: launch-time security material must come from the **website user** (a literal secret the human
typed), never from the **server box** (`$env` names a variable of the server process and reads its
value back through a step's output). Barring `$env` on the override path closes that
"browser reads the server's environment" channel directly, at the value layer, without needing an
auth or origin gate to do it. A literal `$secret` is the intended channel and is safe on the return
path: the engine already masks every secret value out of persisted artifacts at the observation seam
(CONTEXT.md → Secret).

## Considered options

- **Ratify server-api-spec.md §2 unchanged (allow `$env`).** The spec argues `$env` "adds no new
  power": a caller who can post config can already post a `binary` step, and binary steps inherit the
  whole process environment. Rejected here because that equivalence **breaks for the viewer**: the
  browser operator launches *discovered* workflows and cannot author a `binary` step (authoring is
  out of scope, #228), so `$env` on the override path would hand a browser user an env-read power
  they do not otherwise have. The spec itself pre-committed to re-open this argument "if that
  boundary ever moves" — the browser launch surface is that move.
- **Reject `$env` via a dedicated `OperatorConfigSchema`** (a `ConfigObjectSchema` variant with the
  `EnvWrapper` branch removed). Rejected: it re-encodes the recursive `ConfigValue` shape minus one
  branch and drifts from `ConfigObjectSchema`; `secret.ts` already argues against two walks spelling
  one predicate twice.
- **Reject `$env` via a post-parse `mapEnv` walk (chosen).** `POST /v0/runs` keeps validating
  `config` with the shared `ConfigObjectSchema`, then walks the parsed operator config with the
  existing `mapEnv` (`packages/schema/src/env.ts`); any `$env` found → `400` naming its dot-path
  (`operator config may not source from the server environment: $env at "creds.token"`). One walk,
  one predicate, error carries the exact address. `mapEnv` already descends *through* a `$secret`
  wrapper, so the composed `{"$secret": {"$env": "NAME"}}` form is caught by the same walk.
- **Also deny-list specific override keys** (e.g. an `api_endpoint` a binary step POSTs to).
  Rejected: config override rewriting any author-declared key is inherent to the feature and
  identical to the CLI's `--set`; a viewer-specific key denylist is a gate that only looks like one
  (the author can name any key). The `$env` reject is the one deliberate divergence.

## Consequences

- **The server endpoint is now stricter than the CLI.** `path run --set`/`--config` still accepts
  `$env` (mvp-spec §8.3 does not schema-check CLI override values at all); `POST /v0/runs` refuses
  it. Deliberate: the CLI operator already owns the box, the browser operator does not.
- **CSRF / cross-origin is explicitly *not* addressed by this decision.** `POST /v0/runs` is one
  no-auth same-origin endpoint; a malicious site the operator visits can still fire a write-only
  launch (it cannot inject the operator's typed secret and cannot read a response cross-origin
  without CORS). That is a launch-endpoint threat, not a config-value one, and belongs with the
  auth/origin hardening that server-api-spec.md §2 already defers to the boundary-move. Filed as
  [#237](https://github.com/howardyang2009/PATH/issues/237).
- server-api-spec.md §2 and server-api-v0.md §2 both carry the old "allow `$env`, argued not gated"
  wording and need editing to match.
- #228's map ("operator may override config — security fork to pin") records this as the pin.
