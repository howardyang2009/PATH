# The Designer refuses to open a file with an unregistered step type, rather than opening it read-only or boxing the unknown node

**Status:** accepted; resolves the open-behavior half of [#261](https://github.com/howardyang2009/PATH/issues/261)
(the v1 authoring palette), map [#254](https://github.com/howardyang2009/PATH/issues/254). Depends on the
registry-driven palette decided in the same ticket and on
[ADR 0018](0018-open-node-union-via-pure-registry-factory.md) (validity is registry-relative; a pure
consumer receives a registry as data). The contract it produces is written into
[designer-spec.md](../spec/designer-spec.md) § The v1 authoring palette.

## Context

The v1 palette is **registry-driven** (#261): the Designer receives a step-plugin registry as data and
holds one Steps entry per leaf step type it describes, with a three-tier editor (first-class for
`prompt` / `binary` / `workflow`, a generated form for any other type, a live-validated JSON textarea as
the floor). Because the floor never fails, **every leaf type the registry describes opens**. The only
node the canvas cannot render is therefore one whose `type` is **absent from the received registry**.

That happens two ways. A **stale snapshot**: the server has since loaded a plugin the Designer's copy
predates (ADR 0018 sub-decision 3 accepts staleness — the registry is a bare snapshot with no staleness
contract). A **cross-fork file**: a `*.workflow.json` authored in another fork that names a plugin this
tree holds no folder for; a plugin type is portable within a fork lineage, not across forks (CONTEXT.md
§ Step-type plugins), and the server itself reports such a file `valid: false`, not
valid-but-unlaunchable (CONTEXT.md § Discovery,
[server-api-v0.md](../api/server-api-v0.md) §6, [#315](https://github.com/howardyang2009/PATH/issues/315)).

The question (#261, flagged as the one that "matters most" because it decides whether the Designer is
safe to open on an arbitrary existing workflow): what does the canvas do with such a file — **refuse to
open**, **open read-only**, or render the unknown node as an **opaque round-trip node** that boxes its
raw JSON, lets the author edit the rest, and serializes back untouched?

## Decision

**The Designer refuses to open a file with any step type absent from its received registry.** It does
not open the file read-only, and it does not box the unknown node as an opaque round-trip node.

The refusal is **legible and recoverable**, mirroring ADR 0018 sub-decision 5's aggregate load error:

- It names **every** absent type in one message, not the first one hit, plus the
  `packages/engine/step-plugins/<name>/` folder that would resolve each — the same remedy the engine's
  own unknown-type error names.
- Because the same registry source (the server the Designer is talking to) makes a **stale snapshot**
  the only in-fork cause, the refusal offers **refresh-the-registry-and-retry**.

This draws one clean line for the palette: **a type present in the registry always opens** (three
editor tiers, the JSON floor never failing); **a type absent from it refuses the file.** There is no
fourth state.

## Considered options

- **Opaque round-trip node (rejected).** Box the unknown node's raw JSON verbatim, edit the rest, save
  the opaque bytes untouched. Rejected on two grounds. First, **it breaks the strict-union
  architecture.** `makeWorkflowFileSchema(registry)` is a closed `z.discriminatedUnion` and a file with
  an unregistered `type` *fails to parse* through it (ADR 0018). An opaque node requires a **second,
  lenient parse path** outside that door — one that peels known nodes and boxes unknown ones — plus a
  new **byte-fidelity invariant** (the boxed bytes must round-trip identically) and a golden test to
  guard it, none of which exist. Second, **it buys almost nothing.** The write route re-validates every
  save against the server's **live** registry
  ([ADR 0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md), ADR 0018
  sub-decision 3), so a save carrying a type the server lacks is refused `400`. The opaque node cannot be
  saved back where it is missing — exactly the cross-fork case. And where the server *does* have the type
  (the stale-snapshot case), a registry refresh renders it properly instead, with no opaque box needed.
  The machinery lands for a case the write route already rejects.

- **Open read-only (rejected).** Render the known nodes, forbid edits and saves. Rejected as near-useless
  for the file it targets. A file with an unregistered type is `valid: false` in this tree, so it
  **cannot launch** — and launch runs the bytes on disk through `prepareWorkflow`, not the canvas render
  (§ Run surfaces), so read-only rendering adds no run capability either. It also still needs the same
  lenient second parse the opaque option needs, to render *anything* from an unparseable file. It pays
  most of the opaque option's cost for strictly less usefulness.

- **Refuse to open (accepted).** Keeps the single strict-union door, needs no lenient parse and no new
  invariant, matches ADR 0015's refuse-on-structural-defect precedent (a duplicate or malformed `id`
  refuses the open — the Designer already declines to open a file it cannot faithfully author), and
  matches the server's own `valid: false` verdict on the same file. The safety property — *safe to open
  an arbitrary existing workflow* — is met by a **legible, recoverable refusal**, not by admitting a file
  the server would reject on save.

## Consequences

- **The Designer keeps exactly one parse path.** It reads a file only through the strict
  registry-driven schema. There is no lenient reader, no opaque-node type in the client model, and no
  round-trip-fidelity invariant to test. A future need to *view* an unrenderable file (not author it) is
  a separate decision that would have to re-open this one.
- **Recovery from staleness is a registry refresh, not a special open mode.** The refusal's
  refresh-and-retry is the whole in-fork recovery path. This leans on the transport #263 builds: the
  Designer must be able to re-fetch the registry cheaply. #261 pins the entry shape
  (`{ name, fields, workers, defaultWorker }`); #263 owns the route and the refresh trigger.
- **Cross-fork files are out of the Designer's reach by design.** A file naming a plugin this tree lacks
  is not editable here and not launchable here; the remedy is a plugin folder in this fork's tree
  (CONTEXT.md § Step-type plugins), which the refusal message names. This is the accepted cost, stated
  rather than discovered: the Designer authors this fork's workflows, not every fork's.
- **No CONTEXT.md change.** This decision adds no term. It applies existing ones (registry-relative
  validity, fork-lineage-scoped plugin types, the strict open-union door). The normative contract lives
  in the spec; this ADR holds only the *why*.
