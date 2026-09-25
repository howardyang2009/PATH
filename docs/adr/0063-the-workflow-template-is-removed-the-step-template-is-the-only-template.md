# The Workflow-Template is removed; the Step-Template is the only template

**Status:** accepted. Supersedes the Workflow-Template parts of
[ADR 0049](0049-instantiation-is-a-detached-copy-that-re-stamps-ids-and-never-rewires.md) (decision 7,
Workflow-Template instantiation into an empty canvas) and
[ADR 0050](0050-the-template-api-is-id-addressed-and-owns-the-template-write-door.md) (the `workflow`
kind, its `workflow-template/` directories and its `*.workflow-template.json` suffix). Withdraws
[#460](https://github.com/howardyang2009/PATH/issues/460) and
[#579](https://github.com/howardyang2009/PATH/issues/579). Narrows
[#459](https://github.com/howardyang2009/PATH/issues/459) item 6 to "Save as step-template".

## Context

A Workflow-Template was an ordinary workflow file with a `*.workflow-template.json` suffix, kept under
`.path/template/workflow-template/` (or shipped read-only). Selected into an empty canvas, it became a
detached copy with a fresh workflow `id` and fresh node ids, saved as a new `*.workflow.json`.

That is the same result as the Designer's workflow-mode **Save as… Workflow**, which already runs the
same whole-workflow instantiation (`instantiateWorkflow`) over an open workflow. The Workflow-Template
added a separate catalog, shipped starters and a palette card, but it cost a second template kind in
every layer: the template store, both template write routes, the wire types, the Designer's palette,
author mode, the Save-As dialogs, the empty-canvas placement, and the relative-`ref` hazard of
[#561](https://github.com/howardyang2009/PATH/issues/561) for a whole file saved away from its folder.

The Step-Template has no such overlap: it is a fragment inserted into an existing workflow, which
nothing else in PATH does.

## Decision

1. **The Step-Template is the only template kind.** The Server's template store scans only
   `step-template/` (shipped and user) and types only `*.step-template.json`. A leftover
   `*.workflow-template.json` file is ignored: it is not listed, not addressable by id, and not a
   launchable workflow (discovery scans `*.workflow.json` only).
2. **The wire keeps `kind`, as the literal `"step"`.** `TemplateSummary.kind`,
   `GetTemplateResponse.kind` and `WirePostTemplateRequest.kind` stay, typed `"step"`. `POST
   /v0/templates` with `kind: "workflow"` is a `400`. `GET /v0/templates?kind=` accepts only `step`.
3. **The shipped `draft-review.workflow-template.json` is deleted.**
4. **A workflow can be saved as a step-template.** Workflow mode's **Save as…** asks "Workflow…" (a
   copy to a new `*.workflow.json`, unchanged) or "Step-template…": a new user step-template of the
   workflow's **body**, with a fresh `id`, created through `POST /v0/templates`. The workflow-level
   fields (`input`, `output`, `config`, `worker_defaults`) are dropped, and the dialog names the ones it
   drops. The workflow stays open and unchanged.
5. **`PUT /v0/workflows` still refuses a path under `.path/template/`** (the two write doors stay
   disjoint, §10.6), but no longer refuses a `*.workflow-template.json` suffix by name: the suffix
   means nothing now.
6. **`instantiateWorkflow` stays** in `@path/schema`: it is the whole-workflow copy behind Save as…
   Workflow, no longer a template transform.

## Consequences

- A starting-point workflow is now just a workflow: copy it with Save as… Workflow.
- A project that still has `.path/template/workflow-template/*.workflow-template.json` files keeps
  the bytes on disk, but PATH ignores them. To keep one, rename it to `*.workflow.json` and move it out
  of `.path/template/`.
- The format-v5 migration script still rewrites `*.workflow-template.json` files, since it runs over
  old trees.
