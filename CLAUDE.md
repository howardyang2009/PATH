## Code comments

A comment states **what** the code does and any **non-obvious why**, in at most ~3 lines. History ("used to be"), rejected alternatives, and issue numbers (`#123`) belong in the ADR or the commit message, not in source. Cite an ADR or spec section only when the code would look wrong without it, and never as a comment's only content. Keep a package's comment share under 20% of its `src/`; the full rule is in `.sandcastle/CODING_STANDARDS.md`.

## Agent skills

### Issue tracker

PATH tracks issues as GitHub issues in `howardyang2009/PATH` through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
