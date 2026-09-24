# A goto names its target by step name, checked at load in `@path/schema`

**Status:** accepted. Resolves target reference and load-time validation for Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544), ticket
[#551](https://github.com/howardyang2009/PATH/issues/551); origin
[#478](https://github.com/howardyang2009/PATH/issues/478). Builds on
[ADR 0053](0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md) (goto execution
model). Plan-only: no schema or engine code yet.

#478 gives `goto` one field: the step it jumps to, which must be a first-level step of the current
file. ADR 0053 fixed the runtime side: the jump is a `SeqOutcome` whose `target` is the target node's
GUID. This ADR fixes the authored side: how the file names the target, what load refuses, and where
the check lives.

Two facts shape it. ADR 0049 §3 lets Instantiation re-stamp every node `id` without rewiring, because
a body fragment holds no GUID cross-references. And the file load already enforces file-unique
`name`s (`checkWorkflowFileInvariants`), but it does not check duplicate `id`s (only the write door
and the Designer open gate do, ADR 0015).

## Decision

1. **The authored reference is the target's `name`.** A goto node carries `target: "<name>"`. Load
   resolves the name to the target's GUID, and the runtime `SeqOutcome.target` stays a GUID
   (ADR 0053 §2). Resume and pass pairing (ADR 0054) are keyed on GUIDs, so they do not change.

2. **Load refuses four cases:**
   - a. `target` names no node in the file;
   - b. `target` names an inner node (a node under `branch`, `sequence`, `while-do` or `parallel`,
     which includes every node of a `person-switch` instance, ADR 0052);
   - c. `target` names the goto itself (possible only for a first-level goto);
   - d. a goto sits under `while-do` or `parallel` (the placement rule of ADR 0053 §3).

3. **An unguarded first-level goto with a backward target is legal.** It is a loop whose exit is a
   different goto, one that jumps forward past it. `max_jumps` (ADR 0053 §5) stays the backstop: if
   nothing jumps past it, the run fails when the jumps are spent. A first-level forward goto (a skip)
   is legal too.

4. **The verdict is one zod issue per offender, in one failed parse.** Cases a to c put the issue at
   the goto's `target` field. Case d puts it at the goto node. Each message names the goto and the
   target, e.g. `goto target "retry" not found in this file`, `goto target "check" is not a
   first-level step`, `goto "loop" targets itself`, `goto "x" may not sit under while-do "poll"`.
   The zod `superRefine` already collects every issue, so there is no separate aggregator like the
   one for unset `$env`.

5. **The check lives in `@path/schema`.** A new rule module returns the issues as data, in the same
   pattern as `node-identity.ts` and `publishSetIssues`. `checkWorkflowFileInvariants` calls it. The
   rule is structural: it reads only the file's shape, and `goto` is a built-in control member, not
   a registry plugin. Every door that parses a whole file gets the check: the engine load, the
   server template store, and the Designer's draft validation. The check is not in `makeBodySchema`,
   because a template body does not know the file namespace it will land in (ADR 0048 §5).

6. **A step-template body may hold a goto, unchecked until it lands.** Its target is not validated
   in the template. After Instantiation, the target file's check refuses an instance that breaks
   (the goto lands under `while-do`, the target becomes an inner node, or `uniqueName` renamed the
   target). This joins the hazards that ADR 0049 names; Instantiation still does not rewire.

7. **The Designer rewrites a goto target on rename only.** When an author renames a node, the
   Designer rewrites every goto `target` that names the old name. A delete or a move into a container
   rewrites nothing: the draft shows the verdict (case a or b), and the author fixes it. A rename
   cannot change what the author meant; a delete or a move can.

## Considered options

- **Reference the target by `id`.** Survives a rename with no Designer rewrite. Rejected: it is the
  first GUID cross-reference in a body, so every template instance's goto would dangle after the id
  re-stamp (ADR 0049 §3). Load does not check duplicate ids, so a hand-copied node could make the
  target ambiguous. An id is also opaque in the JSON.
- **Refuse an unguarded first-level backward goto.** Rejected (decision 3): a goto elsewhere can jump
  past it, so it is a valid loop shape.
- **Check at the engine load boundary.** Rejected: the Designer and the server would not get the
  verdict, and the rule needs no engine or registry state.
- **Forbid `goto` in step-template bodies.** Rejected: a template that holds a loop is useful, and the
  file check already catches a broken instance.
- **Instantiation rewrites goto targets renamed by `uniqueName`.** Rejected: it reverses ADR 0049 §3
  for one field.
- **The Designer clears or removes gotos when their target is deleted.** Rejected (decision 7).

## Consequences

- The goto node schema gets `target: string` with the `name` pattern (`^[a-z][a-z0-9-]*$`), next to
  `max_jumps`.
- The top-level walk maps `name` to GUID once per workflow-run, from the parsed file.
- A Designer rename touches every goto that names the renamed node, as part of the same edit.
- ADR 0049's hazard list gains the goto target. Nothing refuses the hazard at insert time; the
  draft verdict names it.
