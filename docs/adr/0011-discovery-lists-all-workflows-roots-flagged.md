# Discovery lists all workflows, roots flagged — not roots-only

**Status:** accepted; amends the "valid-roots-only" discovery scoping charted in
[#228](https://github.com/howardyang2009/PATH/issues/228).

The workflow-discovery endpoint (`GET /v0/workflows`, [server-api-v0.md §6](../api/server-api-v0.md))
was first scoped in #228 as "valid roots only, dedupe nested `workflow` refs," and
[#230](https://github.com/howardyang2009/PATH/issues/230)'s title still reads "valid-roots-only." We
reverse that. Discovery lists **every** discovered `*.workflow.json`, each with an `is_root` flag
(`false` means also reachable as another discovered workflow's nested ref). Valid-roots becomes a
client-side filter over a complete list, not a server-side omission.

Why: a nested-ref target is itself a complete, schema-valid workflow (workflow-as-step, CONTEXT.md), and
it is independently launchable via `POST /v0/runs` with operator-supplied `input` and `config`. To drop
it to save a dedupe would hide a legitimately launchable workflow, and the omission cannot be undone
client-side; the information is simply gone. To list all and flag roots keeps both: an operator can
launch any workflow, and a UI can still foreground roots by a filter on `is_root`.

## Considered options

- **Roots-only (original #228 scoping).** A cleaner list, one entry per launch target. Rejected: it
  omits launchable inner workflows, and the drop is irreversible downstream. A client that wants an
  inner workflow cannot recover it from a roots-only response.
- **List all, flag `is_root` (chosen).** It preserves the dedupe information as a per-entry label rather
  than an omission.

## Consequences

- `is_root` is a **presentation/dedupe hint, not a launchability gate.** The endpoint promises nothing
  about self-sufficiency. An inner workflow relies on parent-inherited config (invariant 5, config
  inherits downward) and an undeclared input shape. So **schema-valid does not equal runnable
  standalone** without the right `input` and `config`. That contract is spelled out in
  server-api-v0.md §6.
- Hard to reverse: `GET /v0/workflows` is a `/v0` wire shape, so a later reversal ships as `/v1`, never
  a silent reshape of `/v0`.
- #228's map ("Confirmed scoping" plus delegation plan) needs a one-line amendment that records this
  reversal.
