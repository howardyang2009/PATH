# Opening the closed node union: zod mechanics for a registry-populated discriminator

This document resolves [#312](https://github.com/howardyang2009/PATH/issues/312). It is the
**schema-open** child of [map #308](https://github.com/howardyang2009/PATH/issues/308). #308 asks for
step-type plugins. A step-type plugin is a `./step-plugins/<name>/` folder. The folder contributes a new
leaf step *type* plus its config schema. The engine registers the plugin before it validates a workflow.
The engine does this with no edit to the core union in `@path/schema`. The prior-art survey
[step-plugin-prior-art.md](step-plugin-prior-art.md) settled the cross-engine shape. Its §7.1 says the fix
is to make the *discriminator* open ("validate after lookup"), not to abandon serialization. This document
settles the zod-mechanics half. It shows **how** to open the closed `z.discriminatedUnion("type", [...])`
at [`packages/schema/src/nodes.ts:129`](../../packages/schema/src/nodes.ts) against a runtime-populated
registry, and how to keep what the closed union gives today. It compares three approaches against three
hard constraints. It states which zod API version the repo is on, and what a migration would buy. It ends
with a concrete `makeNodeSchema(registry)` factory.

**Date:** 2026-08-26. **zod version consulted:** `3.25.76`. This is the version that pnpm resolved into
`node_modules/.pnpm/zod@3.25.76`. Every package declares `"zod": "^3.23.8"` (see
[`packages/schema/package.json`](../../packages/schema/package.json)). zod 3.25.x is the hinge release. It
ships the zod **v4** core under the `zod/v4` subpath, while the bare `zod` and `zod/v3` import stays
**v3**. The repo imports `from "zod"`, so it runs v3 today. This document reads both codepaths from the
installed source. It does not infer them. Each claim below carries a source URL, or the installed file
path and line.

**Primary sources.** zod official docs ([zod.dev](https://zod.dev), [zod.dev/v4](https://zod.dev/v4)),
the zod source (github.com/colinhacks/zod), and the **installed** compiled source under
`node_modules/.pnpm/zod@3.25.76/node_modules/zod/`, which is the exact code that runs here. Where a claim
is about internal behavior (what error a discriminator miss emits, how the option array is resolved), this
document cites the installed source file and line, in preference to prose docs.

---

## 1. What the closed union gives today, in zod's own terms

Read [`packages/schema/src/nodes.ts`](../../packages/schema/src/nodes.ts) first. Three properties are
load-bearing. Any opening must preserve all three.

**`.strict()` on every member (no silent extra keys).** `commonStepFields` (lines 11-19) is spread into
eight member schemas. Each member is `z.object({ type: z.literal(...), ...commonStepFields, ... }).strict()`
(lines 21-127). `.strict()` sets `unknownKeys = "strict"` on the object def. An unexpected key produces an
`unrecognized_keys` issue, rendered as `Unrecognized key(s) in object: <keys>` (installed
`zod/v3/types.js:1975-1984`, message `zod/v3/locales/en.js:17-18`). This check lives on the object schema
itself. So it fires no matter how the parse reaches the object (union dispatch, direct call, or a
second-phase lookup). That fact lets every approach below keep strictness.

**A legible miss error on an unknown or absent `type`.** `NodeSchema` is
`z.discriminatedUnion("type", [PromptStepSchema, ... CheckpointNodeSchema])` (lines 129-138). The v3
discriminated union resolves the discriminator by a direct map lookup. On a miss, it emits a specific issue
(installed `zod/v3/types.js:2426-2435`):

```js
const discriminatorValue = ctx.data[discriminator];
const option = this.optionsMap.get(discriminatorValue);
if (!option) {
  addIssueToContext(ctx, {
    code: ZodIssueCode.invalid_union_discriminator,
    options: Array.from(this.optionsMap.keys()),
    path: [discriminator],
  });
  return INVALID;
}
```

The default message (installed `zod/v3/locales/en.js:23-24`) is
`Invalid discriminator value. Expected 'prompt' | 'binary' | 'workflow' | 'parallel' | 'branch' | 'while-do' | 'sequence' | 'checkpoint'`
at path `["type"]`. This is the "unknown `type` rejected before any step runs" property that
[api-door-pipeline-shape.md](api-door-pipeline-shape.md) §1 relies on. It reads well *because v3 lists
every valid key in the message*. An absent `type` (value `undefined`) takes the same path.
`optionsMap.get(undefined)` misses, and gives the same message.

**Recursion through the union, with `z.lazy`.** `NodeArraySchema` and `SingleNodeSchema` (lines 60-61) are
`z.lazy(() => ...)` wrappers. Each closes over the module-level `NodeSchema` const. Members reference them:
`ParallelNodeSchema.branches` (line 74), `BranchArmSchema.node` (line 83), `WhileDoNodeSchema.node` (line
104), and `SequenceNodeSchema.body` (line 116). So a node can contain nodes. Note one detail: the lazy
wraps *the slots inside members*, not the members themselves. `z.discriminatedUnion` still receives eight
concrete `.strict()` objects. Each object exposes `.shape.type` as a `ZodLiteral`. This detail governs the
dynamic-rebuild approach (§4). A factory must rebuild the recursion, so that the lazy closes over the *new*
union. If it does not, plugin types are invalid inside `sequence`, `parallel`, and `branch` bodies.

**The purity constraint.** `@path/schema` has zero runtime deps but zod. The registry must arrive as
**data** (a `Map` or array, passed in). It must never read from `fs`, and it must never run an import-time
side effect. The shape to evaluate is a factory, `makeNodeSchema(registry)`. The impure loader package
calls the factory, after it has scanned `./step-plugins/*/`. This document judges every approach on one
test: does it keep the schema package a pure function of its inputs?

---

## 2. Which zod API the repo is on, and the v3/v4 split that matters here

The bare import resolves to v3. Installed `zod/index.js` and `zod/index.d.ts` both read
`export * from "./v3/external.js"`. The `package.json` `"."` export maps `import` to `./index.js`
(installed `zod/package.json`). The v4 core is present, but only under `zod/v4`, `zod/v4-mini`, and
`zod/v4/core`. So today `z.discriminatedUnion` is the v3 implementation from §1.

Four v4 differences bear on this problem. Each is pinned below. §7 gives the practical weighing.

- **Discriminated unions compose in v4.** The v4 release notes state, verbatim: "discriminated unions now
  *compose*: you can use one discriminated union as a member of another"
  ([zod.dev/v4](https://zod.dev/v4)). They also state that v4 "supports a number of schema types not
  previously supported, including unions and pipes" as options. In v3 this is impossible. `getDiscriminator`
  (installed `zod/v3/types.js:2370-2413`) returns `[]` for a `ZodUnion` or `ZodDiscriminatedUnion`. So
  `discriminatedUnion.create` throws `A discriminator value for key "type" could not be extracted from all
  schema options` (installed `zod/v3/types.js:2474-2476`). The consequence for PATH: in v3 you cannot pass
  a plugin *sub-union* as a member. You can pass only flat `.strict()` objects. In v4 a plugin could
  contribute its own discriminated sub-union.
- **The miss error changed, and v4's default reads *worse*.** v4's discriminated union pushes
  `{ code: "invalid_union", note: "No matching discriminator", path: [discriminator] }` (installed
  `zod/v4/core/schemas.js:986-995`). The default message for `invalid_union` is the bare `"Invalid input"`
  (installed `zod/v4/locales/en.js:104-105`). The `note` is metadata. The default map does not render it. So
  out of the box, **v3 names the valid types in the message, and v4 does not**. To match v3's legibility on
  v4, you must supply a custom `error`. This is the sharpest counter-intuitive finding: a v4 migration
  *regresses* the unknown-type message, unless you write one.
- **The construction model is lazier in v4.** v3 builds `optionsMap` eagerly inside `create`, and it can
  throw at construction (installed `zod/v3/types.js:2469-2492`). v4 defers the discriminator map behind
  `util.cached` and `defineLazy`. It computes the map on the first parse, from each option's
  `_zod.propValues` (installed `zod/v4/core/schemas.js:936-967`). v4 also adds a `unionFallback` def flag.
  On a discriminator miss, it re-runs the options as a plain union (installed
  `zod/v4/core/schemas.js:983-984`). A flat plugin registry needs neither. But both make v4 more tolerant of
  lazily-resolved or composed options.
- **Error and strict ergonomics were unified.** v4 replaces `message`, `errorMap`, `invalid_type_error`,
  and `required_error` with a single `error` param. The param may return a plain string or `undefined`
  ([zod.dev/v4 migration](https://zod.dev/v4/changelog)). v4 deprecates `.strict()` and `.passthrough()`
  in favor of `z.strictObject()` and `z.looseObject()` (same source). The docs say the deprecated forms
  "will not be removed" and are "considered legacy". v4's `.superRefine` `ctx` no longer eagerly evaluates
  `path`, which the docs call "a necessary change that unlocks Zod 4's dramatic performance improvements"
  (same source). None of these forces a migration. `.strict()` keeps working on v4.

**Net result:** the repo is on v3, and for *this* problem v3 is not the poor cousin. Its eager miss error
is the more legible one. A flat plugin registry never needs v4's composition. v4 earns its migration only
if plugins must contribute *sub-unions*, or if the team wants the v4 performance and `error`-param cleanup
for other reasons. See §7.

---

## 3. Approach 1: two-phase parse (thin outer discriminates, registry supplies phase two)

**Shape.** A thin outer schema reads `type` off an object, but does not commit to a closed set. Then the
loader looks the plugin's own `z.object({...}).strict()` up in the registry. It parses the whole object
against that schema, as a second phase.

```ts
const Outer = z.object({ type: z.string() }).passthrough(); // read the tag, keep the rest
function parseNode(raw: unknown, registry: Map<string, StepPlugin>) {
  const head = Outer.safeParse(raw);
  if (!head.success) return head;                 // not even an object with a string `type`
  const plugin = registry.get(head.data.type);
  if (!plugin) {
    // phase-two miss: a message WE author
    return { success: false, error: `Unknown step type "${head.data.type}". Known types: ${[...registry.keys()].join(", ")}` };
  }
  return plugin.schema.safeParse(raw);            // full .strict() validation of the real shape
}
```

**Strictness:** kept. Phase two is the plugin's own `.strict()` object. So `unrecognized_keys` fires
exactly as it does today (installed `zod/v3/types.js:1975-1984`).

**Miss error quality:** this is the approach's strongest card, and also its main cost. The miss is *your*
control flow, not zod's. So the message is whatever you write. You can make it strictly better than either
zod default: name the offending value, list known types, and (unlike v3's map) include *plugin-contributed*
types, because the registry is the source. But you own it. You must get the phrasing, the path, and the
"absent against unknown" distinction right by hand. You must keep the message consistent with the rest of
zod's issue formatting, so that callers that walk `error.issues` do not hit a differently-shaped error. The
message is legible by construction, and non-uniform by construction.

**Recursion:** this is the real tax. `parseNode` is a function, not a `ZodType`. So it does not compose
inside `z.array(...)` or a `z.lazy` slot. To validate `sequence.body` or `parallel.branches`, you must do
one of two things. You wrap `parseNode` in a `z.custom` or `superRefine` (which collapses this into
approach 3). Or you thread the two-phase dispatch by hand, through every recursive slot. The eight core
members already lean on `NodeArraySchema` and `SingleNodeSchema` (nodes.ts lines 60-61, 74, 83, 104, 116).
To re-implement that recursion outside zod is the hidden bulk of this approach.

**Purity:** clean, if the caller passes the `registry` in. No `fs`, no import side effect.

**Verdict:** best *message*, but it leaves zod's compositional world. So it re-implements recursion, and it
gives up a uniform issue shape. Reach for it only if you need a bespoke miss message that the union cannot
express. Even then, prefer to feed that message through approach 2's `error` param.

---

## 4. Approach 2: build the discriminated union dynamically at registry-freeze time

**Shape.** After plugins load, assemble the options array from the core members plus the plugin members.
Hand the array to `z.discriminatedUnion` once, inside `makeNodeSchema(registry)`.

**Can `z.discriminatedUnion` take a runtime-built array? Yes, natively.** The v3 constructor signature is
`static create(discriminator, options, params)`, and it simply iterates `options` (installed
`zod/v3/types.js:2469-2484`). Nothing requires a literal array or compile-time membership. An array built
from `[...registry.values()]` is exactly what it iterates. The constructor enforces one requirement: each
option must expose `.shape[discriminator]`, from which `getDiscriminator` can extract a literal or enum
value (installed `zod/v3/types.js:2474-2483`). A plugin schema shaped as
`z.object({ type: z.literal("<name>"), ...commonStepFields, ... }).strict()` satisfies that requirement. A
`.strict()` object is still a `ZodObject` with a `.shape`.

**Behavior when the array is spread from core + plugin members.** `[...coreMembers, ...pluginMembers]`
works, as long as every element is a flat `.strict()` object with a literal `type`. Respect two failure
modes. Both come from the same source:

- **A duplicate `type`**, across a core member and a plugin, throws at construction:
  `Discriminator property type has duplicate value <value>` (installed `zod/v3/types.js:2478-2481`). This
  is a *feature*. It turns a plugin that shadows a built-in type into a loud, load-time error, which is the
  behavior that [step-plugin-prior-art.md](step-plugin-prior-art.md) §7.4 wants (fail fast, named). The
  loader must catch the error and reframe it. The loader must not suppress it.
- **A plugin member that is itself a union** throws in v3 (`... could not be extracted from all schema
  options`, installed `zod/v3/types.js:2474-2476`). The reason: v3 `getDiscriminator` does not recurse into
  unions. On v3, use flat objects only. This is the exact limitation that v4 composition lifts (§2, §7).

**Miss error quality:** identical to today's closed union, and that is the point. The dynamically-built
union still emits `invalid_union_discriminator` with `options: Array.from(optionsMap.keys())` (installed
`zod/v3/types.js:2429-2435`). So the message now lists **core plus plugin** types automatically:
`Invalid discriminator value. Expected 'prompt' | ... | '<plugin-a>' | '<plugin-b>'`. There is no
hand-written message. The issue shape is uniform. The plugin types appear for free, because they are in the
same `optionsMap`. This is strictly better than approach 1 on uniformity, and equal on legibility, with
zero bespoke code.

**Recursion:** solvable, and it is the one thing the factory must get right. The core members' recursive
slots must reference the *union being built*, not the old module-level `NodeSchema`. Declare a `z.lazy`
node schema that closes over the new union. Build `NodeArraySchema` and `SingleNodeSchema` from *that*.
Build the core members with those. Then build the union. Because `z.lazy`'s getter runs at parse time, the
union is assigned by then (§6 sketch). Done this way, plugin steps become valid *inside* `sequence`,
`parallel`, `branch`, and `while-do` bodies. The two-phase approach gets that only by re-threading
recursion by hand.

**Cost and timing.** One construction per registry freeze. v3 pays it eagerly. `create` walks every
option and builds `optionsMap` at call time (installed `zod/v3/types.js:2469-2484`), which is O(members),
a few microseconds for a dozen members, once at boot. The parse-time cost is a single `Map.get` on the
discriminator (installed `zod/v3/types.js:2428`). That is the same direct-lookup advantage the closed union
has today. It is the reason discriminated unions "avoid sequential checking"
([zod.dev discriminated unions](https://zod.dev/api?id=discriminated-unions)). There is no per-parse
rebuild. The engine calls `makeNodeSchema` once, when it freezes the registry, and it reuses the returned
schema for every workflow file.

**Purity:** clean. `makeNodeSchema(registry)` is a pure function of an injected `Map`. The `fs` scan lives
in the loader package that calls it.

**Verdict:** the natural opening. It reuses zod's own dispatch and its own legible miss message. It keeps
`.strict()` untouched. The only real engineering is to rewire recursion inside the factory (§6).

---

## 5. Approach 3: `z.custom` / `superRefine` dispatch

**Shape.** A single schema whose body dispatches to the registry by hand, and pushes issues through the
refinement context.

```ts
const NodeSchema = z.custom<WorkflowNode>().superRefine((raw, ctx) => {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected a node object with a type", fatal: true });
    return z.NEVER;
  }
  const plugin = registry.get((raw as any).type);
  if (!plugin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["type"],
      message: `Unknown step type "${(raw as any).type}". Known: ${[...registry.keys()].join(", ")}`, fatal: true });
    return z.NEVER;
  }
  const res = plugin.schema.safeParse(raw);
  if (!res.success) for (const iss of res.error.issues) ctx.addIssue(iss); // re-emit, preserving each path
});
```

**Message ergonomics:** total control. `ctx.addIssue` lets you set `code`, `message`, `path`, and `fatal`.
`fatal: true`, plus returning `z.NEVER`, aborts. So a bad `type` does not cascade into confusing downstream
issues ([zod.dev refinements](https://zod.dev/api?id=refinements)). The unknown-type message is yours, the
same upside as approach 1. The catch is that you must re-emit the plugin's own issues. You must copy
`res.error.issues` onto `ctx`, and prefix their `path` with the current location. Then a `.strict()`
violation deep in a plugin config still reports where it happened. If you miss that, the strict
`unrecognized_keys` message survives, but its `path` is wrong.

**Strictness:** kept, because phase two is still the plugin's `.strict()` object. But it is kept only if you
forward the issues faithfully (see the previous paragraph).

**Recursion:** `z.custom(...).superRefine(...)` *is* a `ZodType`. So, unlike approach 1, it composes inside
`z.array` and `z.lazy` slots. That makes it viable for the recursive grammar, without leaving zod. The
price: you lose the discriminated union's *narrowing* and its free miss message, and you hand-roll issue
plumbing that the union does for you.

**Note the v4 refinement caveat.** On v4, `ctx` "does not eagerly evaluate the `path` array"
([zod.dev/v4 migration](https://zod.dev/v4/changelog)). So path-forwarding code written against v3
`ctx.path` needs review before a migration. On v3 (today) this does not bite.

**Purity:** clean. The caller injects the registry. No `fs`.

**Verdict:** the escape hatch. Use it where a slot needs cross-field logic, or a message the union truly
cannot express. As the *primary* opening, it is more manual than approach 2, for no legibility gain over a
custom `error` on the union.

---

## 6. Comparison against the three hard constraints

| | Keeps `.strict()` (no silent extra keys) | Legible unknown/absent `type` error | Keeps `@path/schema` pure (registry as injected data) |
|---|---|---|---|
| **1. Two-phase parse** | Yes: phase two is the plugin's `.strict()` object, `unrecognized_keys` fires unchanged (`zod/v3/types.js:1975-1984`) | Best control, fully hand-authored; can name plugin types and the bad value, but you own phrasing, path, and issue-shape uniformity | Yes, if `registry` is passed in |
| **2. Dynamic discriminatedUnion** | Yes: members are unchanged `.strict()` objects | zod's own `invalid_union_discriminator` now lists core + plugin types automatically (`zod/v3/types.js:2429-2435`); no bespoke code, uniform issue shape | Yes: `makeNodeSchema(registry)` is a pure function of an injected `Map` |
| **3. `z.custom`/`superRefine`** | Yes, but only if you re-emit the plugin's issues with correct `path` | Full control via `ctx.addIssue` (`code`/`message`/`path`/`fatal`); manual, same upside as #1 | Yes, if `registry` is injected |

Two secondary axes break the tie. The first is **recursion**. Approach 2 keeps zod-native recursion, by
rewiring the factory. Approach 1 must re-thread recursion by hand, outside zod. Approach 3 composes, but it
hand-rolls issue plumbing. The second is **uniformity**. Approach 2 reuses zod's issue shape. Approaches 1
and 3 author their own, and must stay consistent with it.

---

## 7. Recommendation

**Adopt approach 2: a dynamically-built discriminated union, behind a `makeNodeSchema(registry)` factory.
Stay on zod v3 for now.** It is the only approach that preserves all three of today's properties, with zero
bespoke error code. `.strict()` is untouched, because the members are the same strict objects. The
unknown-`type` message stays legible *and* uniform, because it is zod's own `invalid_union_discriminator`,
now listing core plus plugin types. The package stays pure, because the registry is an injected `Map`.
Approaches 1 and 3 are escape hatches, for a slot that needs a message or a cross-field rule the union
cannot express. Keep them in the toolbox, not on the main path.

**v3 against v4 for this problem.** Stay on v3. The repo runs v3 today (`zod/index.js` re-exports
`./v3/external.js`). A migration is not free. For a *flat* plugin registry, v3 is actually the better fit.
Its miss message names every valid type out of the box. v4's discriminated-union miss defaults to the bare
`"Invalid input"`, and it would need a custom `error` just to match today's legibility (§2). Move to
`zod/v4` only when a concrete need appears. One such need is a plugin that must contribute its **own
discriminated sub-union** (v4's composition, "discriminated unions now compose",
[zod.dev/v4](https://zod.dev/v4); impossible in v3, per `zod/v3/types.js:2474-2476`). Another is a broader
appetite for v4's unified `error` param and performance work. If PATH migrates, pass a custom `error` to
`discriminatedUnion`, to restore the type-listing message. Until then, v3 loses nothing here.

**The `makeNodeSchema(registry)` factory (recommended shape).** It is pure, it preserves `.strict()`, it is
recursion-correct, it gives a legible miss error, and it has zero deps but zod:

```ts
import { z } from "zod";
import type { WorkflowNode } from "./node-type.js";

// The loader (impure, does the ./step-plugins/*/ scan) builds this and passes it in.
// Each plugin schema MUST be z.object({ type: z.literal("<name>"), ...commonStepFields, ... }).strict()
export type StepPlugin = { type: string; schema: z.ZodObject<z.ZodRawShape, "strict"> };

export function makeNodeSchema(registry: ReadonlyMap<string, StepPlugin>): z.ZodType<WorkflowNode> {
  // Declared first; the lazy getter runs at parse time, by when `union` is assigned.
  const NodeSchema: z.ZodType<WorkflowNode> = z.lazy(() => union);

  // Rewire recursion so slots reference THIS union, not the old module-level NodeSchema.
  const NodeArraySchema: z.ZodType<WorkflowNode[]> = z.lazy(() => z.array(NodeSchema).min(1));
  const SingleNodeSchema: z.ZodType<WorkflowNode> = NodeSchema;

  const coreMembers = buildCoreMembers({ NodeArraySchema, SingleNodeSchema }); // the 8 strict objects
  const pluginMembers = [...registry.values()].map((p) => p.schema);

  // Runtime-built array is accepted natively (zod/v3/types.js:2469-2484).
  // A plugin type duplicating a core type throws here, loud and load-time (…:2478-2481), which is desired.
  const union = z.discriminatedUnion("type", [...coreMembers, ...pluginMembers]);
  return NodeSchema;
}
```

`buildCoreMembers` is today's eight `.strict()` objects (nodes.ts lines 21-127), lifted into a function.
The function takes the two recursive schemas as parameters. So the recursion closes over the freshly-built
union, and plugin steps validate inside `sequence`, `parallel`, `branch`, and `while-do` bodies. The
loader package owns the `fs` scan and the duplicate-type reframing. `@path/schema` exports only this pure
factory, plus the `StepPlugin` type. This keeps its "zero deps but zod" contract.
([step-plugin-prior-art.md](step-plugin-prior-art.md) §7.3's folder contract feeds this loader. §7.4's
fail-fast-on-absent maps onto the duplicate-`type` throw and the `invalid_union_discriminator` miss.) When
PATH opens `@path/schema` this way, `NodeSchema`'s current module-level `export const` (nodes.ts:129)
becomes the `registry = new Map()` default call of `makeNodeSchema`. So the built-in-only behavior is the
empty-registry case, and nothing downstream changes until a plugin is dropped in.

---

## 8. Claims not fully pinned to a primary source

- **v4 discriminated-union *performance*, relative to v3.** v4's release notes advertise a large overall
  parser speedup, and the discriminated union's direct-lookup dispatch is visible in source
  (`zod/v4/core/schemas.js:952-981`). But no official page gives a v3-against-v4 microbenchmark for
  discriminated unions specifically. §2 frames the performance claim as "construction is lazier" (pinned to
  source) and general v4 speed (pinned to the changelog). It is not a measured union delta.
- **v4 `unionFallback` public surface.** The installed v4 core reads the flag
  (`zod/v4/core/schemas.js:983-984`). But this pass did not trace which classic-API option name sets it, or
  whether it is stable public API, to a docs page. This document notes it as an internal tolerance
  mechanism, and does not recommend it for PATH.
- **Exact v4 default render of the `note` field.** The claim that v4's discriminator miss carries
  `note: "No matching discriminator"` is from source (`…schemas.js:990`). The claim that the default `en`
  map renders `invalid_union` as `"Invalid input"` is from source (`zod/v4/locales/en.js:104-105`). The
  claim that no shipped locale surfaces the `note` was spot-checked on `en` only, not across every locale
  file.
- **GitHub-hosted line numbers.** The line citations are against the **installed** `zod@3.25.76` source,
  which is the code that runs here. The public github.com/colinhacks/zod tree at the matching tag keeps the
  same symbols (`ZodDiscriminatedUnion`, `getDiscriminator`, `$ZodDiscriminatedUnion`). But its TypeScript
  source line numbers differ from the compiled `.js` cited here.
