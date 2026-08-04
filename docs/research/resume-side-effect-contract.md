# Resume door — what a half-landed side effect owes an at-least-once world

The decision fixed by [map #142](https://github.com/howardyang2009/PATH/issues/142) ticket
[#147](https://github.com/howardyang2009/PATH/issues/147): given the cause-blind rule reruns
every run whose status is not `succeeded`, and a `binary` step (or a `prompt` step's worker-side
tool call) may have already had an external effect before the process died — what does resume
owe the world for that effect?

This does not touch reuse or invalidation. [#145](https://github.com/howardyang2009/PATH/issues/145)
and [#146](https://github.com/howardyang2009/PATH/issues/146) settled what a **succeeded** run's
recorded output is worth. This ticket is about the other side: a run that **reruns** because it
never reached `succeeded`, and what re-executing it a second time can do to state outside PATH's
own records.

## The rule

> Resume is **at-least-once** for every run it reruns. If a `binary` step's child process, or a
> `prompt` step's worker-side tool call, already produced an external effect before the run
> stopped, resume repeats that step and the effect can fire again. PATH observes stdout, stderr,
> and exit code for a `binary` run (or the LLM's structured result for a `prompt` run) — nothing
> about the state of the world — so it cannot detect, prevent, or reconcile a duplicated effect,
> and it does not try to. Idempotency, or avoiding externally-visible effects altogether, is the
> workflow author's obligation, not an engine guarantee. This holds identically for `binary` and
> `prompt` steps: the engine has no way to tell which is "safer" to rerun, so it does not gate
> resume on step type. Nothing about invoking `resume` more than once changes this — every
> invocation reruns the same not-`succeeded` runs the same way, cause-blind already means there is
> no first-resume/second-resume distinction to draw.

## Why the rule is sound

### 1. What the record actually knows is nothing, by construction

`runBinaryStep` (`packages/engine/src/binary-worker.ts`) captures exactly three things from a
child process: stdout (become the step's output), stderr (captured to `stderr.txt`, §6), and the
exit code (zero/non-zero decides `succeeded`/`failed`). Nothing else is read back — no filesystem
diff, no check of whatever external system the command talked to. mvp-spec §5.5 draws the same
line for the worker contract generally: a step's input map is the whole of what it reads, and
`stderr` is explicitly "not data." There is no artifact anywhere in `.path/runs/` that could answer
"did the git push land" — the question the issue opens with expected exactly this answer, and nothing
in the engine's design contradicts it. This is not a gap to close; observing world-state was never
part of what PATH's audit trail promises (CONTEXT.md's Observation/Log-event entries cover `input`,
`output`, `context`, `stderr` — never external state).

### 2. Nothing in v0 today actually breaks under this rule — by accident, not by design

Checked every `binary` command in every workflow file in the repo (`release-notes.workflow.json`,
`revise-cycle.workflow.json`, `github-release-notes.workflow.json`, `changelog.workflow.json`,
`env-secret-probe.workflow.json`) plus both JS helper scripts they shell out to
(`format-changelog.js`, `join-issue-refs.js`):

- Every `git` invocation is a **read** (`log`, `--stat`, `--no-merges`) — never `push`, `commit`,
  or anything mutating.
- The one `curl` call (`fetch-issues` in `github-release-notes.workflow.json`) is a **GET** against
  the GitHub issues API — never POST/PUT/PATCH.
- Every file write (`write-file` in three workflows, `use-token`'s receipt file in
  `env-secret-probe.workflow.json`) is `cat > file` or `writeFileSync` — a **full overwrite**,
  naturally idempotent: running it again reproduces the same file from the same input, not a
  duplicate or a corrupt append.
- Both helper scripts are pure stdin→stdout transforms with no filesystem or network access.

So today, re-running any `binary` step a second time reproduces the same world-state, never a
duplicated effect. This is worth recording precisely because it is not a property the format or the
engine enforces — an author is free to write a `binary` step that runs `git push` or POSTs to an
API tomorrow, and nothing stops them. The rule above is what governs that step once it exists, not
a claim that today's pipelines already needed it.

### 3. The "cheaper boundary" the issue floated does not hold up

The issue's own last bullet asks whether resume could refuse trees with an in-flight `binary`,
while still allowing resume through trees where only `prompt`/LLM steps were in flight — a
narrower door, no idempotence burden on the author, if it works.

It does not work, because mvp-spec §7 makes MCP servers and tools a **worker-side option** on a
`prompt` step's invocation (`options` bag on the `llm` worker declaration) — "not engine concerns
— no engine code speaks MCP in MVP." A `prompt` step's tool call can write a file or hit an API
exactly as a `binary` step's command can, and the engine is exactly as blind to it: same
stdout/exit-code-shaped observation, same absence of a world-state check. The boundary's premise —
`binary` is the risky one, `prompt` is safe to rerun through — is false. Shipping it would be worse
than shipping nothing: an operator would read "no binary was in flight" as "safe to resume" when a
tool call inside an in-flight `prompt` step could have already fired.

Rejected. Resume does not gate on step type. The at-least-once rule in §1 above applies uniformly
instead — the only answer that does not depend on a distinction the engine cannot draw.

## Forward dependencies recorded, not annexed

- **Engine visibility into worker-side tool effects.** The MCP-blind-spot this ticket surfaces —
  the engine cannot see what a `prompt` step's tools did, resume or not — is not a new gap; it is
  already the shape of mvp-spec §10's deferred register row: *"MCP/skill step types — live as
  LLM-worker `options`; revisit only for engine-direct calls."* No new ticket opened; whoever
  revisits that row inherits this ticket's finding too.
- **CLI/format surface for resume** (warning text, a flag, anything an operator sees when
  resuming a tree with side-effecting steps) is the next map's, per #142's own "designing or
  building the resume surface" exclusion. This ticket states the contract; it builds nothing.
- **CONTEXT.md** is not touched by this ticket, matching #145/#146's precedent: no `resume`
  glossary term exists yet because the CLI/format surface is still undecided
  (#142's "not yet specified" list). A glossary entry is owed once that surface lands, not before.
