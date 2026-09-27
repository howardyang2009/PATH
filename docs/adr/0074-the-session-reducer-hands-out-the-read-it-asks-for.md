# The session reducer hands out the read it asks for

**Status:** accepted.

The Designer's session was described as "the one pure `(state, action) => state`", but a read crossed
that seam twice:

- The **hook** minted the fetch token (`loadSeq = useRef(0)`), passed it in on `openLoading` /
  `openTemplateLoading` / `descend` / `reload`, and then called `pendingFetch(state, seq)` — which
  read the state the reducer had just produced, checked `frames[activeIndex].loadSeq === seq`, and
  returned the frame to read.
- The **reducer** stored that token on the frame and re-checked it on `loadLanded`, dropping a
  landing whose frame had moved on.

So an I/O token the reducer never minted and never used for its own reasons rode its action and state
types, and two mechanisms guarded the same property — with the hook's comment admitting the seam leak
("the reducer's verdict read back as I/O intent"). The hook also had to assume the reducer's layout
(`must(next.frames[next.activeIndex], "opened frame")`), and four call sites repeated the
apply-then-maybe-fetch dance.

## Decision

1. **The reducer returns an outcome**: `reduceSession(state, action) → { state, fetch }`, where
   `fetch: FetchRequest | null` is `{ frame, depth, token }` — the loading frame to read, where it
   lands, and the token a landing must echo.
2. **The reducer owns the token.** `openLoading`, `openTemplateLoading`, `descend` and `reload` no
   longer carry one; the reducer mints it from `SessionState.loadToken` (absent means 0) and stamps
   the frame. A monotonic counter in the state, not in a frame, is what survives a read that replaces
   the whole trail.
3. **Only the reading actions ask for a read.** A `READS` table in the reducer names them, and the
   fetch is the newly loading active frame — so `descend` that re-enters the frame ahead, a `reload`
   of an unwritten buffer, and every non-reading action produce `fetch: null` without the hook
   guessing.
4. **`loadLanded` carries the token it echoes** and keeps the same guard (a frame the author left,
   replaced, or that already landed holds another token, so the result is dropped).
5. **The hook executes**: `apply(action)` returns the outcome, and `applyAndFetch(action)` performs
   `outcome.fetch` if there is one. `pendingFetch`, the `loadSeq` ref, and the `must(...)` layout
   assumption are gone.

## Considered Options

- **Return the effect** (chosen). One place decides what is in flight, and the type says so; the
  staleness guard keeps a single home.
- **Keep the hook's token and `pendingFetch`.** Rejected: the state's shape is then an I/O protocol
  the caller must know, and the same property is still guarded twice.
- **Park the pending request in the state** (a `pendingFetch` field the hook consumes). Rejected. A
  must-consume-exactly-once value in state is re-read on every render and on any reducer replay; the
  returned effect has no such lifetime.
- **Emit the request as an action-like callback** (`reduce(state, action, emit)`). Rejected: it makes
  the reducer impure at the seam where its purity is the point — the transition suites drive it with
  no client and no server.

## Consequences

- **The transition suites read `.state`** through a one-line helper, and the read protocol has its own
  suite: the token a read hands out, a fresh token per read, the actions that ask for nothing, the
  landing that patches, and the three landings that are dropped.
- **`Frame.loadSeq` stays** as the reducer's own "this frame awaits token N" marker; it is no longer
  an action field a caller sets.
- **The surfaces' contract is unchanged**: `SessionState` gains an optional `loadToken` counter,
  so the many test fixtures that build a state literal need no edit.
- **No behaviour change**: the same reads are performed for the same actions, and the same landings are
  dropped; the designer's 458 tests pass, including the four App-level suites that drive real fetches.
