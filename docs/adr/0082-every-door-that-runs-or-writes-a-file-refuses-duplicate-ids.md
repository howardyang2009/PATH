# Every door that runs or writes a file refuses duplicate ids

**Status:** accepted. Refines [ADR 0015](0015-designer-node-identity-client-mints-preserve-on-save.md).

ADR 0015 split the identity checks by door: the load refinement enforces unique names, the write route
refuses internally duplicate ids, and the Designer refuses duplicate and invalid ids on open. The
engine's tree load, which every run goes through, applied only the load refinement. A hand-edited file
whose nodes share an id ran, and Resume then paired nodes by an id that was not unique. Format §5.6
already said the load rejects duplicate ids.

## Decision

1. **`duplicateIdErrors(file)` lives in `@path/schema`**: the workflow's own id and every node id in
   one namespace, one line per offence naming both paths.
2. **The write route and `loadWorkflowTree` both apply it.** A file with duplicate ids cannot run
   from the CLI or the server, and lists as invalid.
3. **The load refinement still accepts the file**, so the Designer can open it and name the colliding
   pair for a human to resolve (ADR 0015).
