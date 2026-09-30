# The authored layout decides where a file lives and who may write it

**Status:** accepted. Extends [ADR 0084](0084-authored-files-live-in-shipped-shared-and-per-user-folders.md),
[ADR 0085](0085-discovery-lists-only-the-authored-workflow-roots.md) and
[ADR 0086](0086-shipped-workflows-are-copied-before-they-run.md).

ADR 0084 put authored files in shipped, shared and per-user folders, and ADR 0086 said a shipped
workflow is never run or written in place. Eight modules in four packages each held one piece of
that layout: a path builder, an inverse parser for template paths, two shipped-directory resolvers, a
root list in discovery, a regex in the client tree, and two directory constants in the Designer. The
"never in place" rule lived only in the clients. `PUT /v0/workflows` and `POST /v0/runs` checked no
origin, so a project that contains its PATH install (this repository) could overwrite or run a
shipped workflow in place. The Viewer and the Designer also decided "copy first" separately and
disagreed on an invalid shipped row, and a failed copy could leave a partial folder that answered
`409` forever.

## Decision

1. **One Server module, the authored layout, owns the root table.** For each kind it lists the
   shipped, shared and user roots in precedence order, which are writable, and the user id. It
   classifies any project path to its root, and it scans a kind's files for every reader.
2. **Every workflow door asks the layout before it acts.** Write, delete, launch, resume and complete
   refuse a template path (`400`) and a shipped path (`403`), whether or not the shipped root lies
   inside the project.
3. **Discovery sends the decision, not the layout.** Each row carries its `root_path` and a Server
   decided `action` (`open`, `copy`, `none`), and the response lists the writable `roots`. Clients
   switch on `action` and read `roots`; they hold no folder constants or path regex.
4. **The workflow store is the path-addressed door onto workflow files**, as the Template store is
   the id-addressed door onto templates (ADR 0050, ADR 0083). Both scan through the layout. The two
   write doors stay disjoint (ADR 0084).
5. **A shipped copy is all or nothing.** Every file's content is decided before the first write; the
   copy is staged in a dot-folder that discovery skips and renamed into place. A workflow file that
   does not parse refuses the copy with `400`.

## Consequences

- When the Server learns who is asking, the user id changes in the layout alone.
- Tests drive the layout's classification and the workflow store's writes without HTTP.
- `relative_path` still depends on the origin, but only as the handle its row's `action` takes.
