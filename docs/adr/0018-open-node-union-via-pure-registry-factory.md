# The closed node union opens through a pure `makeWorkflowFileSchema(registry)` factory

**Status:** accepted; the schema-open decision of map [#308](https://github.com/howardyang2009/PATH/issues/308),
resolving [#310](https://github.com/howardyang2009/PATH/issues/310). Informed by
[zod-open-union.md](../research/zod-open-union.md) (zod mechanics, resolves #312) and
[step-plugin-prior-art.md](../research/step-plugin-prior-art.md) §7 (cross-engine shape). Does not
re-open #308's locked decisions or the #309 keystone.

**Amended** three times since, all inline below; nothing here is superseded. The
[#313](https://github.com/howardyang2009/PATH/issues/313) resolution (the executor seam and dispatch)
pinned the registry entry's full shape — sub-decisions 3, 4 and 6.
[ADR 0019](0019-step-plugins-are-folders-under-packages-engine-step-plugins.md) (the folder contract,
#314) amended sub-decisions 3 and 6 again. The
[#315](https://github.com/howardyang2009/PATH/issues/315) resolution (workflow-file portability and
format versioning) amends sub-decisions 3 and 5. No code implements this ADR yet, so each amendment is an
in-place correction rather than a superseding record.

**Sub-decision 3 has been amended three times and its original property is gone.** Read the amendments,
not the paragraph above them.

`NodeSchema` is a **closed** `z.discriminatedUnion("type", [...])`
([`packages/schema/src/nodes.ts:129`](../../packages/schema/src/nodes.ts)), validated inside `@path/schema`
— a **pure** package with zero runtime deps but zod — before the engine runs a workflow
(`loadWorkflowTree` → `safeParseWorkflowFile`). A **step-type plugin** (#308) contributes a new leaf step
type whose config fields must validate through this same door. The question (#310): how does the union
open to a plugin-contributed schema without the schema package reading the filesystem, and without
regressing what the closed union gives today?

Decision: **open the union by building it dynamically inside a pure factory, `makeWorkflowFileSchema(registry)`,
that closes over an injected registry of loaded plugins. `@path/schema` stays a pure function of its
inputs; the engine owns discovery and injects the registry as data.** The three load-bearing properties of
today's union are all preserved: `.strict()` on every member, a legible miss error on an unknown/absent
`type`, and recursion through the union via `z.lazy`.

The seven pinned sub-decisions:

1. **Mechanism — a dynamically-built `z.discriminatedUnion`, not a two-phase parse or a `superRefine`.**
   After plugins load, the factory assembles the options array from the core members plus the plugin
   members and hands it to `z.discriminatedUnion` once. zod v3 accepts a runtime-built array natively — the
   v3 constructor simply iterates `options` (installed `zod/v3/types.js:2469-2484`); nothing requires
   compile-time membership. This reuses zod's own direct-`Map.get` dispatch and its own miss error, keeps
   `.strict()` untouched, and needs zero bespoke error code — the properties that
   [zod-open-union.md](../research/zod-open-union.md) §4, §7 select it for.

2. **zod v3, not a v4 migration.** The repo runs v3 (`zod` bare import re-exports `./v3/external.js`;
   `zod@3.25.76` ships v4 only under the `zod/v4` subpath). For a **flat** plugin registry v3 is the better
   fit: its `invalid_union_discriminator` miss names every valid type out of the box, while v4's
   discriminated-union miss defaults to the bare `"Invalid input"` and would need a custom `error` merely to
   match today's legibility (zod-open-union.md §2). v4 earns a migration only when a plugin must contribute
   its **own discriminated sub-union** — impossible in v3, where `getDiscriminator` throws on a union member
   (installed `zod/v3/types.js:2474-2476`) — or for unrelated v4 performance/`error`-param reasons.

3. **The registry arrives as an optional parameter on the existing door, empty-map default.**
   `safeParseWorkflowFile` / `parseWorkflowFile` gain a `registry?` parameter; the engine's `loadWorkflowTree`
   (impure, owns the future `./step-plugins/*/` scan) builds the registry and passes it. The **empty
   registry reproduces today's built-in-only grammar exactly**, so nothing downstream changes until a plugin
   drops in. No `fs`, `glob`, or import-time side effect ever enters `@path/schema`.

   **Amended (#313).** A registry entry is not a bare `ZodRawShape`. It is
   `{fields, workers, defaultWorker}`: the extra-field fragment, the type's named workers, and which
   worker is the default. `@path/schema` reads `fields` and the worker **names**; the workers' `run`
   methods are data it never calls, so the package's purity is unchanged. One registry rather than a
   schema one beside a dispatch one is what stops a type validating at load and finding no worker at
   dispatch.

   **Amended (ADR 0019).** "The empty registry reproduces today's built-in-only grammar exactly" no
   longer holds. Sub-decision 10 of that ADR ships `binary` and `prompt` as plugin folders, so an empty
   registry describes no leaf step at all. The built-in grammar is now a fact about what sits in
   `packages/engine/step-plugins/`, not a property of `@path/schema`.

   **Amended (#315). The registry is a required parameter, and the empty-registry defaults are deleted.**
   Once ADR 0019 removed the property above, the optional `registry?` with an empty-map default stopped
   being a convenience and became a loaded gun: it type-checks, it runs, and it rejects every real
   workflow with `Unknown step type "binary" — no plugin contributes it`, which reads as a bug in PATH
   rather than a missing argument at the call site. So `makeWorkflowFileSchema(registry)` and the parse
   doors take the registry with **no default**, and the module-level `NodeSchema` / `WorkflowFileSchema`
   consts are **deleted rather than redefined** — there is no schema to export without a registry. A
   caller that forgets one fails to compile, at the site of the mistake.

   This also closes a hole ADR 0019 opened without naming. The Consequences below claimed purity is "the
   property that lets the schema keep validating in the browser designer"; once the built-in grammar
   moved into the folder, a consumer that cannot scan that folder had no grammar at all. The rule is that
   such a consumer **receives** a registry as data — the same injection this sub-decision already
   describes, one process further out. It never guesses, and it cannot fall back to a built-in set,
   because there is no longer a built-in set to fall back to.

   The received registry is a **bare snapshot with no staleness contract**. ADR 0019 sub-decision 17
   rebuilds the registry per load and cache-busts on folder mtime, so a long-lived consumer's copy can go
   stale mid-session. PATH does not version it and does not gate a write on it: `PUT /v0/workflows` keeps
   its ETag precondition on the file's **bytes**
   ([ADR 0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md)), and the server
   re-validates every write against its own live registry, so a stale consumer's write is refused as an
   ordinary schema error. A second precondition axis would buy a nicer message for a rare race, not a
   caught bug. This matches the stance ADR 0019 sub-decision 17 already takes one layer down — "a run
   already in flight holds the worker functions it loaded". The accepted cost, stated rather than
   discovered: a design surface whose registry went stale sees a rejected write it believed valid.

   The **wire shape** that carries a registry to a pure consumer is not designed here. It belongs to the
   execution map #308 seeds. This amendment fixes only that the registry is received, never guessed, and
   that no empty-registry default remains for a consumer to reach for instead.

4. **A plugin declares only its extra-field fragment; the schema layer composes the envelope.** A registry
   entry contributes a `ZodRawShape` of its *extra* fields only (e.g. `{ url, method }`). The factory adds
   `type: z.literal(<registry key>)`, spreads the shared `commonStepFields` (`id`, `name`,
   `config?`, `input?`, `parse?`, `publish?`), and applies `.strict()`. The three invariants — strictness
   present, common fields present, discriminant equal to the folder name — become **impossible for a plugin
   author to declare wrong**, because the package owns them, not each plugin. A fragment key colliding with a
   `commonStepFields` name is rejected loud at registry-freeze, naming the field.

   **Amended (#313).** `worker` has left `commonStepFields`. Under the #309 keystone a worker is a
   type-scoped **name**, so the factory builds `worker` **per member** as a `z.enum` of that type's
   worker names, taken from the same registry entry. A workflow naming a worker the type does not have
   then fails at load, with the valid names listed, from zod's own error. `parse` deliberately stays
   shared: the registry knows the worker names statically, but it cannot know whether a given run's
   result is a string, so there is no load-time check to move.

5. **The no-plugin-loaded error names the offending type, via one custom `error` callback.** A workflow that
   references a type the registry does not hold fails to load. v3's default `invalid_union_discriminator`
   lists the *expected* types but never echoes the *received* bad value. Since the type name **is** the
   plugin folder name (#308 locked decision 2), the missing thing to name is that value, so the union carries
   a custom `error` that echoes it and lists the known types:
   `Unknown step type "api-call" — no plugin contributes it. Known types: prompt, binary, …`. This is a
   single, principled exception to the "zero bespoke code" appeal, matching the `$env` unset-var stance
   ([ADR 0012](0012-operator-config-rejects-env-wrapper.md); `describeUnsetEnv`,
   `packages/engine/src/resolve-env.ts:121`). The schema package can only distinguish **loaded** from
   **not-loaded**; "present on disk but failed to load" is #314's discovery territory, not this message.

   **Amended (#315). The error aggregates, and it names the remedy.** A workflow file declares no
   dependency block — the `type` values in `body` *are* its dependency list — so this message is the
   whole of PATH's portability reporting, and it is what makes declining a `requires` block safe. It must
   therefore do in one pass the job a `requires` check would have done:

   - **Every** missing type in one failure, not the first one hit. The `$env` precedent this sub-decision
     cites already works this way: `describeUnsetEnv` (`packages/engine/src/resolve-env.ts:121`) dedupes
     by name and reports `3 environment variables are not set: …`. The singular wording pinned above did
     not match the precedent it named. Someone porting a file wants the whole list, not three
     edit-and-retry cycles.
   - The **remedy**, named. Under ADR 0019 the fix is a folder in the reader's own PATH tree, so the
     message says so instead of leaving the reader to infer it.

   The echoed type name and the known-types list both survive; this widens the message rather than
   replacing it. The distinction drawn above — that `@path/schema` can only tell **loaded** from
   **not-loaded**, and that "present on disk but broken" is ADR 0019 sub-decision 16's to report — is
   untouched.

6. **Built-in type names are reserved; a plugin shadowing one is a loud load-time reject.** The factory
   pre-checks each plugin key against the fixed built-in set (`prompt`, `binary`, `workflow`, `parallel`,
   `branch`, `while-do`, `sequence`, `checkpoint`) **before** building, so the message is PATH's own and
   stable regardless of zod's phrasing. A shadow is rejected, never an override — the built-in always wins.
   (zod's own duplicate-value throw at construction, installed `zod/v3/types.js:2478-2481`, is the backstop,
   not the primary check.) Two plugin folders of one name collide earlier, in #314's discovery.

   **Amended (#313).** The reserved-name set and the dispatch registry are two different sets, and the
   ADR should not be read as making them one. The **reserved set** stays the eight built-in node type
   names above, because a plugin named `while-do` must be rejected even though a control node never
   holds a worker (CONTEXT invariant 1). The **dispatch registry** holds leaf step types only, seeded
   with `binary` and `prompt` before the folder scan, so a plugin shadowing a seeded leaf type also
   collides on an existing key. The reserved list is checked first, so the message stays PATH's own.

7. **The factory produces the whole `WorkflowFileSchema`, and the schema is built once per registry
   freeze.** Because `NodeArraySchema` and `WorkflowFileSchema` transitively embed the union, the real
   factory is `makeWorkflowFileSchema(registry)` (with `makeNodeSchema` as its inner piece); the module-level
   `const` exports become the empty-registry default calls. The factory rewires the `z.lazy` recursion so
   `sequence` / `parallel` / `branch` / `while-do` bodies close over the **new** union — otherwise plugin
   steps would be invalid inside those bodies (zod-open-union.md §4, §6). `loadWorkflowTree` builds the
   schema **once** at entry and parses every file in the ref tree against the held schema through a
   lower-level `safeParseWorkflowFileWith(schema, json)`; the registry-taking `safeParseWorkflowFile(json, registry?)`
   stays as the build-then-parse convenience door for single-file callers. This preserves the
   "one construction per freeze, O(members)" cost the research relies on, rather than rebuilding the union
   once per file.

## Considered options

- **Two-phase parse (a thin outer reads `type`, the registry supplies phase two).** Rejected as the primary
  opening. It yields the best hand-authored message but leaves zod's compositional world: `parseNode` is a
  function, not a `ZodType`, so it does not compose inside `z.array` or a `z.lazy` slot, and the recursive
  grammar (`sequence.body`, `parallel.branches`) must be re-threaded by hand outside zod (zod-open-union.md
  §3). Kept in the toolbox as an escape hatch for a slot that needs a message the union cannot express.
- **`z.custom` / `superRefine` dispatch.** Rejected as primary. It *is* a `ZodType` and composes, but it
  hand-rolls issue-path plumbing that the union does for free, and it must faithfully re-emit each plugin
  issue with the correct `path` or strictness errors report the wrong location (zod-open-union.md §5). Also an
  escape hatch, not the main path.
- **Migrate to `zod/v4` now.** Rejected. For a flat registry v4 *regresses* the unknown-type message and
  buys nothing here; deferred until a concrete sub-union need appears (option 2 above).
- **Plugin hands a fully-assembled `.strict()` object.** Rejected (sub-decision 4). It puts the three
  invariants in every plugin author's hands — a forgotten `.strict()` or a wrong `type` literal silently
  mis-registers. The fragment-plus-composition contract makes them un-forgettable.
- **Accept zod's free miss message as-is.** Rejected (sub-decision 5). It never echoes the offending type,
  which is exactly the thing the issue asks the load error to name.

## Consequences

- **`@path/schema`'s public surface changes.** `NodeSchema` and `WorkflowFileSchema` stop being the primary
  `const`s and become the empty-registry default calls of the factory; a new `makeWorkflowFileSchema(registry)`,
  a `safeParseWorkflowFileWith(schema, json)`, and the `registry?` parameter on the existing door are added.
  A `StepPlugin` / registry type is exported. The eight core members (`nodes.ts:21-127`) lift into a
  `buildCoreMembers({ NodeArraySchema, SingleNodeSchema })` function so the recursion can close over the new
  union.
- **The package stays pure.** No `fs`, `glob`, or import-time side effect enters `@path/schema`; the registry
  is injected data. This is what makes a pure consumer — a browser design surface, or any other — possible
  at all. It does not by itself give one a *grammar*: post-ADR-0019 there is no built-in set to fall back
  on, so a pure consumer must be handed a registry (sub-decision 3, amended by #315).
- **The engine owns the freeze point.** `loadWorkflowTree` is where the registry is built and the schema is
  frozen for the whole ref tree. Registry construction, plugin discovery order, and the folder contract are
  **not** decided here — they are [#314](https://github.com/howardyang2009/PATH/issues/314). The executor /
  dispatch registry is [#313](https://github.com/howardyang2009/PATH/issues/313); this ADR governs only the
  *schema* door.
- **The config-vs-field-vs-input line is deferred.** Sub-decision 4 fixes *where* a plugin's extra fields
  attach (the strict envelope), not *which* of them are `$env`/`$secret`-capable config versus step input —
  that line is [#320](https://github.com/howardyang2009/PATH/issues/320).
- **Portability of a workflow file that names a plugin type** is resolved by
  [#315](https://github.com/howardyang2009/PATH/issues/315), which amends sub-decisions 3 and 5 above and
  writes the rest into [workflow-format-v2.md](../format/workflow-format-v2.md) §1/§4,
  [server-api-v0.md](../api/server-api-v0.md) §6, and CONTEXT.md. In short: a file needs **no `requires`
  block** (its `type` values are its dependency list); a plugin type **does not bump `format`**, because
  `format` fixes the grammar shape and keys the codemod chain while the registry fixes the type set;
  discovery reports such a file **invalid**, not valid-but-unlaunchable; and portability is **fork-lineage
  scoped**, since ADR 0019 fixed distribution as clone-or-fork. This ADR's own contribution stands
  unchanged — such a file *fails to load* with a named-type error — now widened to name every missing type
  and the remedy.
