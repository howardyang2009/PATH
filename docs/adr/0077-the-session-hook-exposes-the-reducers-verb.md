# The session hook exposes the reducer's verb

**Status:** accepted. Builds on [ADR 0074](0074-the-session-reducer-hands-out-the-read-it-asks-for.md).

`OpenSession` declared fifteen callbacks over a reducer with eighteen actions: `open`, `openTemplate`,
`newFile`, `newTemplate`, `switchMode`, `descend`, `descendNewUnbound`, `goTo`, `applyEdit`, `undo`,
`redo`, `reloadActive`, and three real I/O verbs. Twelve were one-line `apply({ type: X })` wrappers,
so every new session action cost the interface a method, and the hook's surface restated the
reducer's vocabulary instead of naming it.

The wrappers also carried a precondition the interface never stated. Five of them returned silently
while the step-plugin registry had not landed:

```ts
const open = useCallback((path: string): void => {
  if (!pluginsRef.current) return;   // the read vanishes, and no interface says why
  applyAndFetch({ type: "openLoading", path });
}, [applyAndFetch]);
```

The deep-link open — the one open nobody clicks — was patched by an `openedInitial` ref plus an
effect that waited for `registry.phase === "ready"`, because an open applied before the registry
landed would be dropped. The patch covered one call site; a `descend` or a `reload` taken during
startup was still lost.

## Decision

1. **`OpenSession` exposes the reducer's verb.** `apply(action: SessionAction)` replaces the twelve
   wrappers, beside the three I/O verbs that are not transitions (`save`, `saveAs`, `deleteActive`)
   and the state the surfaces read (`registry`, `frames`, `activeIndex`, `mode`, `saveState`).
2. **A read waits for its parser.** `apply` performs the read the reducer's outcome asks for; when
   the registry has not landed, that read is queued and run the moment it does. No action is dropped
   for arriving early, and no caller checks readiness.
3. **The deep-link open is an ordinary apply.** It is applied once, like any other action; the queue
   is what makes it survive a slow registry, so the `openedInitial` effect is only a once-guard.
4. **A surface may name its own gesture.** The canvas keeps `descend`/`goTo`/`applyEdit` as local
   functions over `apply`, because those names are the canvas' vocabulary, not the session's.

## Considered Options

- **Keep the named callbacks** and add the registry queue behind them. Rejected: the interface still
  restates the reducer action for action, and the queue would have to be remembered by each wrapper.
- **Park the pending read in session state.** Rejected by ADR 0074 for the same reason: a
  must-consume-once value in state is re-read on every render.
- **Drop a read that arrives before the registry** (the behavior that existed). Rejected: a read is a
  fact the author asked for, and the deep-link open is the case that proves it.

## Consequences

- **A new session action needs no hook change**; the reducer and its action union are the only
  place a transition is declared.
- **Tests drive the verb**: `undo.test.tsx`, `save-point.test.tsx` and `use-ref-authoring.test.ts`
  apply actions and read the state the reducer produced.
- **`use-open-file.test.ts` pins the queue**: an open applied while the registry is held open lands
  when it arrives.
