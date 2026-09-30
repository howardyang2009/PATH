# Authored files live in shipped, shared and per-user folders

**Status:** accepted. Supersedes the directory parts of
[ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md) and
[ADR 0050](0050-the-template-api-is-id-addressed-and-owns-the-template-write-door.md) (user templates
under `.path/template/step-template/`, shipped templates under `packages/server/template/step-template/`)
and ADR 0063 decision 5 (the `.path/template/` refusal path).

## Context

User templates lived under `.path/template/step-template/`. User workflows had no home: the Designer
offered the project root. That placement has four problems:

- `.path/` is the **store** (run database and run blobs). It is gitignored and relocatable with `-C`,
  so authored files kept there are neither versioned nor stable.
- Workflow discovery skips dot-directories, so a workflow saved under `.path/` is invisible.
- PATH will have several users. Each user needs an own space, and a team needs a space that no single
  user owns.
- The `step-template/` level repeats what the `*.step-template.json` suffix already says. The
  Step-Template is the only kind (ADR 0063), and a user who makes subfolders gets one extra level
  everywhere.

## Decision

1. **Three origins, one shape.** Authored files live in three roots, each with a `workflow/` and a
   `template/` folder:

   | Root | Origin | Writable |
   | --- | --- | --- |
   | `packages/server/shipped/template/` | `shipped` | no |
   | `shared/template/`, `shared/workflow/` | `shared` | yes |
   | `users/<user-id>/template/`, `users/<user-id>/workflow/` | `user` | yes |

   `shared/` and `users/` sit in the **project directory**, next to `.path/`, never inside it.
   `.path/` holds the store only.
2. **No kind folder.** A template's kind is its suffix. `template/` holds `*.step-template.json`
   directly or in subfolders.
3. **Folders only organize.** A user can make any subfolder under `workflow/` or `template/`. The
   template scan walks each root at any depth, skipping dot-directories and symlinks, as workflow
   discovery does. A template's `name` is still its file stem.
4. **Duplicate id: first root wins.** The scan order is shipped, shared, user. A later entry with a
   held id lists as `valid: false`.
5. **`<user-id>` is `local` until the Server knows who is asking.** Save-as writes to
   `users/local/template/`. The Designer's first save of a new workflow starts in
   `users/local/workflow/`.
6. **The two write doors stay disjoint.** `PUT` and `DELETE /v0/workflows` refuse a path under
   `shared/template/` or `users/<user-id>/template/`. A workflow under `users/<user-id>/workflow/` or
   `shared/workflow/` is an ordinary workflow: discovery lists it and the workflow doors write it.
7. **Shipped workflows are not part of this change.** `examples/` stays sample content, not a product
   asset.

## Consequences

- `.path/template/` is no longer scanned. To keep a template from there, move it to
  `users/local/template/`.
- The wire `origin` gains `"shared"`.
- A project decides whether to commit `users/` and `shared/`. This repository ignores both, since its
  own root is a scratch project.
- Per-user access control, a real user id, and filtering discovery by owner come later and need their
  own decision.
