# The Resume gate lives in `Project.resume`

**Status:** accepted.

Plain Resume had two gates. The server route refused a live root and a **succeeded** root before the
engine saw the request; `Project.resume` refused only a live root. The CLI calls `Project.resume`
directly, so `path run --resume` and `POST /v0/runs/:id/resume` disagreed on the same run.

The route's rule was also wrong in one case. A `do-not-wait` branch left `cancelled` under a
`succeeded` root is unfinished work, and Resume re-runs it (ADR 0009). The acceptance test for ADR
0009 resumes exactly such a tree through the CLI. The route refused it.

## Decision

1. **`Project.resume` owns the whole gate.** It refuses, as a 409 refusal:
   - a tree whose root is not terminal (nothing to resume yet);
   - on a plain Resume, a tree where **every** run succeeded (nothing to resume).
   A rerun boundary K lifts the second refusal (ADR 0032).
2. **The route and the CLI only translate** the refusal, as they already did for legal-K.
3. **`listEligible` applies the same precondition with a boundary in mind**, so a fully succeeded
   tree is still listed.

## Consequences

- Over HTTP, a succeeded root with a non-succeeded detached branch is now resumable, as on the CLI.
- The route recovers the workflow file before the engine refuses, so a live run whose file is gone
  answers 404 instead of 409.
- The Viewer still enables plain Resume from the root status alone (`failed` or `cancelled`). It
  cannot offer Resume for the detached-branch case; the server is the authority.
