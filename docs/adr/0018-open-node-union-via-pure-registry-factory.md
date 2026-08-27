# The closed node union opens through a pure `makeWorkflowFileSchema(registry)` factory

**Status:** accepted; the schema-open decision of map [#308](https://github.com/howardyang2009/PATH/issues/308),
resolving [#310](https://github.com/howardyang2009/PATH/issues/310). Informed by
[zod-open-union.md](../research/zod-open-union.md) (zod mechanics, resolves #312) and
[step-plugin-prior-art.md](../research/step-plugin-prior-art.md) §7 (cross-engine shape). Does not
re-open #308's locked decisions or the #309 keystone.

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

4. **A plugin declares only its extra-field fragment; the schema layer composes the envelope.** A registry
   entry contributes a `ZodRawShape` of its *extra* fields only (e.g. `{ url, method }`). The factory adds
   `type: z.literal(<registry key>)`, spreads the shared `commonStepFields` (`id`, `name`, `worker?`,
   `config?`, `input?`, `parse?`, `publish?`), and applies `.strict()`. The three invariants — strictness
   present, common fields present, discriminant equal to the folder name — become **impossible for a plugin
   author to declare wrong**, because the package owns them, not each plugin. A fragment key colliding with a
   `commonStepFields` name is rejected loud at registry-freeze, naming the field.

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

6. **Built-in type names are reserved; a plugin shadowing one is a loud load-time reject.** The factory
   pre-checks each plugin key against the fixed built-in set (`prompt`, `binary`, `workflow`, `parallel`,
   `branch`, `while-do`, `sequence`, `checkpoint`) **before** building, so the message is PATH's own and
   stable regardless of zod's phrasing. A shadow is rejected, never an override — the built-in always wins.
   (zod's own duplicate-value throw at construction, installed `zod/v3/types.js:2478-2481`, is the backstop,
   not the primary check.) Two plugin folders of one name collide earlier, in #314's discovery.

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
  is injected data. This is the property that lets the schema keep validating in the browser designer and any
  other pure consumer.
- **The engine owns the freeze point.** `loadWorkflowTree` is where the registry is built and the schema is
  frozen for the whole ref tree. Registry construction, plugin discovery order, and the folder contract are
  **not** decided here — they are [#314](https://github.com/howardyang2009/PATH/issues/314). The executor /
  dispatch registry is [#313](https://github.com/howardyang2009/PATH/issues/313); this ADR governs only the
  *schema* door.
- **The config-vs-field-vs-input line is deferred.** Sub-decision 4 fixes *where* a plugin's extra fields
  attach (the strict envelope), not *which* of them are `$env`/`$secret`-capable config versus step input —
  that line is [#320](https://github.com/howardyang2009/PATH/issues/320).
- **Portability of a workflow file that names a plugin type** (does it round-trip without the plugin loaded,
  and how format versioning treats plugin types) is [#315](https://github.com/howardyang2009/PATH/issues/315),
  not this ADR. This ADR only fixes that such a file *fails to load* with a named-type error when the plugin
  is absent.
