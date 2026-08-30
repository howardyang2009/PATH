# Step plugins are convention-only folders under `packages/engine/step-plugins/`, built-ins included

**Status:** accepted; the folder-contract and discovery decision of map
[#308](https://github.com/howardyang2009/PATH/issues/308), resolving
[#314](https://github.com/howardyang2009/PATH/issues/314). Builds on the #309 keystone (a Worker is a
named `run` method per step type), [ADR 0018](0018-open-node-union-via-pure-registry-factory.md) (the
schema opens through a pure `makeWorkflowFileSchema(registry)` factory, #310), and the
[#313](https://github.com/howardyang2009/PATH/issues/313) resolution (the executor seam and one-lookup
dispatch). Informed by [step-plugin-prior-art.md](../research/step-plugin-prior-art.md) §7.3.

**Amends** ADR 0018 sub-decisions 3 and 6, and the #313 resolution's sub-decisions 2 and 19. Those
amendments are stated in full below, under "What this amends". No code implements ADR 0018 or #313 yet,
so these are in-place corrections rather than superseding records.

**Built on** by the [#315](https://github.com/howardyang2009/PATH/issues/315) resolution
(workflow-file portability and format versioning), which draws the consequences of sub-decisions 9, 16
and 17 out to the file format, discovery, and a pure consumer. Nothing here is amended by it;
sub-decisions 16 and 17 below carry its consequences inline, and the Consequences section records what
it settled.

ADR 0018 fixed *how* a plugin's schema reaches the parser — the engine builds a registry and injects it
into a pure factory — and named `loadWorkflowTree` as the function that owns the freeze point. #313
fixed *what* a registry entry holds: `{fields, workers, defaultWorker}`. Neither said where a plugin
lives on disk, what files it consists of, when it is loaded, or what happens when two plugins, or a
plugin and a built-in, want the same name. That is this ADR.

Decision: **a step plugin is a directory under a single fixed location,
`packages/engine/step-plugins/<name>/`, holding one conventional entry module and no manifest. The
engine scans that one directory, imports each entry, and freezes the registry before the first workflow
file parses. `binary` and `prompt` ship as folders there like any other plugin.** There is no second
location, no search path, and therefore no precedence order and no cross-layer shadowing rule anywhere
in this design.

## The sixteen pinned sub-decisions

### The folder

1. **Convention-only. There is no `plugin.json`.** The folder holds one entry module; a manifest would be
   a second declaration of facts the folder already states. The concrete cost of a manifest is the exact
   failure mode #314 asked about: a manifest that names a type disagreeing with the folder that contains
   it. Version and engine-compat, when the lifecycle work wants them, become keys in the entry module's
   own export, not a second file that can drift from the first. This follows the prior art's read of the
   GitHub Actions folder model over n8n's `package.json` node manifest
   ([step-plugin-prior-art.md](../research/step-plugin-prior-art.md) §7.3).

2. **The entry module declares no type name, so the folder-name binding cannot be violated.** #308 locked
   decision 2 makes the folder name the type name. This ADR enforces it by leaving the plugin author no
   way to state a type name at all: the export is `{fields, workers, defaultWorker}`, and the registry key
   comes from the directory entry the scan read. "Folder name ≠ declared type" is not a rejected state,
   it is an unrepresentable one. This is the same discipline ADR 0018 sub-decision 4 applies to the
   discriminant, `.strict()`, and the common fields — the layer that owns an invariant is the layer that
   states it.

3. **The entry file is exactly `index.ts`.** One path, probed once, no ordered fallback list. PATH is a
   tsx-hosted runtime top to bottom: `packages/engine/bin/path.ts` begins `#!/usr/bin/env -S npx tsx`,
   and every workspace package's `exports` points at `./src/index.ts`. There is no compiled entry point
   anywhere in the repo, so a `.js` fallback would be a rule with nothing behind it. Accepting `.js`
   later is purely additive and breaks no plugin written against this one.

   The consequence is worth stating plainly rather than discovering later: **this contract couples step
   plugins to a TypeScript-capable host.** A future compiled distribution of PATH must either keep a TS
   loader or extend this sub-decision.

4. **The export is named, `stepPlugin`, not a default export.** Both fail detectably when missing, so
   this is not a safety argument. A named export is greppable across a plugin tree, survives being
   re-exported through a barrel, and leaves the module free to add sibling exports — helpers, test
   fixtures — with no ambiguity about which one the engine takes.

5. **A plugin imports `z` and `defineStepPlugin` from one public subpath, `@path/engine/plugin`.** Two
   zod instances would break the `instanceof` checks the schema factory depends on, and a plugin folder
   cannot be assumed to resolve a bare `zod` specifier to the engine's copy. So the engine re-exports
   zod beside the helper, and the contract is that a plugin takes zod from there. A dedicated subpath
   rather than the `@path/engine` root, because the root hands out `loadWorkflowTree`, `openProject` and
   `runWorkflow` — none of which a plugin has any business calling. A separate `@path/plugin` workspace
   package would buy the same separation at the cost of another package to version in step.

6. **Everything else in the folder is the author's business.** The engine reads exactly one path inside
   it. Helpers, tests, fixtures and local imports are ordinary relative imports, subject only to
   sub-decision 16's freshness limit.

### Where the engine looks

7. **One fixed location: `packages/engine/step-plugins/<name>/`.** Not the workflow file's directory, not
   the project directory, not an upward search, not a global location, and not several with a precedence
   order.

   Two rejected anchors are worth recording, because both look right at first. Anchoring on the
   **project directory** would have broken [ADR 0005](0005-path-run-dash-c-is-store-only.md): `Project.dir`
   *is* the `-C` value when `-C` is given (`packages/engine/src/cli.ts:373`,
   `parsed.args.storeDir ?? workflow.workflowDir`), so `-C` would silently change which step types exist —
   and the same workflow file would have a different valid grammar with and without a flag documented as
   store-only. Anchoring on the **workflow file's own directory** kept ADR 0005 intact but forced every
   workflow in a subdirectory to carry its own copy of every plugin, this repo's own
   `docs/acceptance-workflow/` included.

   A single fixed location has a property neither alternative offers: it makes the whole class of
   discovery questions #314 asked disappear rather than answering them. Two plugins claiming `api-call`
   is impossible, because a directory holds one entry per name. There is no precedence order to specify,
   no cross-layer shadow to message, and no anchor to derive — which is also what makes sub-decision 11
   moot below.

8. **The location is resolved relative to `import.meta.url`, never `process.cwd()`.** A cwd-relative
   resolution would make the set of valid step types depend on which directory the operator's shell was
   in. PATH already holds the opposite rule everywhere else — a relative path anchors to the workflow
   file, never to the shell that launched `path run` (`packages/engine/src/run-workflow.ts:582`, #313
   sub-decision 14). A repo-root search would reintroduce the upward walk this sub-decision exists to
   avoid.

9. **Shipped and user plugins share the one directory, and all of them are tracked in git.** A user's
   `api-call/` sits beside PATH's `binary/`. Splitting them into a shipped location and a user location
   would buy separation that costs a precedence rule — the thing sub-decision 7 was chosen to eliminate.

   This fixes PATH's distribution model as **clone-or-fork**, which is what `packages/engine`'s
   `"private": true` already makes it: your plugins live in your fork and merge against upstream like any
   other source change. The honest cost, recorded so nobody is surprised by it: a future PATH release that
   ships a plugin whose name a user already used produces a real merge conflict. That is visible and
   fixable, which a silent shadow across two locations would not be.

   **If PATH is ever published as a package, this sub-decision must be revisited before it is**, because
   `packages/engine/step-plugins/` would become `node_modules/@path/engine/step-plugins/` — a directory
   every install wipes, taking user plugins with it.

10. **`binary` and `prompt` ship as folders there, not as engine-seeded code.** This closes #308's parked
    dogfood item. The gain is not symmetry for its own sake: the shipped built-ins import from the public
    `@path/engine/plugin` subpath exactly as a third-party plugin does, so the plugin surface is proven
    expressive enough by PATH's own most demanding step type — on every load, rather than by a test
    fixture or by the first third-party plugin discovering it is too narrow. `prompt`'s folder pulls in
    `@anthropic-ai/claude-agent-sdk`, already an engine dependency, so nothing moves in the dependency
    graph.

11. **There is no per-entry anchor, so a nested-ref file cannot see a different registry standalone than
    it sees under its parent.** Under any workflow-relative anchor this divergence was real and had to be
    accepted, because refs are only known *after* a file parses and parsing needs the registry — so the
    registry could only ever be anchored at the entry file. A fixed location removes the question: one
    location, one registry, identical for every file in every tree.

### Scan and load

12. **Candidates are directories only; dot-prefixed directories are skipped; the list is sorted
    lexicographically before loading.** `README.md` and `.DS_Store` are not plugins. The sort is not
    cosmetic: `readdir` order is not guaranteed across platforms or filesystems, and without a sort the
    *first reported error* when two folders are both broken would differ between machines, which is how a
    test passes locally and fails in CI.

13. **A folder name must match `^[a-z][a-z0-9-]*$`, checked at scan.** The name becomes a `z.literal` and
    a `type` value in author-written JSON. All eight core type names already match this shape
    (`prompt`, `binary`, `workflow`, `parallel`, `branch`, `while-do`, `sequence`, `checkpoint`), so the
    rule is "look like a core type name", not a new convention. It is what keeps CONTEXT's claim true —
    that a built-in and a plugin type are indistinguishable to a workflow author.

14. **The reserved-name check fires at scan, before import, and the reserved set is six names.** The set
    is `workflow`, `parallel`, `branch`, `while-do`, `sequence`, `checkpoint` — exactly the control
    constructs the walker owns, which hold no worker and no run (CONTEXT invariant 1) and can therefore
    never legitimately be a folder.

    `binary` and `prompt` leave the reserved set, because sub-decision 10 makes them folders and the
    check would otherwise reject PATH's own shipped plugins. Nothing is lost by their departure: a
    directory cannot hold two entries of one name, so the collision the reservation existed to catch is
    structurally impossible for them. Replacing `binary` means replacing its folder, which is a
    filesystem act by someone editing their own fork, not a registry conflict for the engine to detect.

    The check runs **before** the import so its verdict does not depend on whether the offending plugin
    happens to load. A folder named `while-do` whose `index.ts` also throws should report the reserved
    name, which is the actionable truth, not "plugin failed to load", which is the incidental one.

15. **`loadWorkflowTree` becomes async, and remains the sole freeze point.** Loading a plugin is
    `await import()`; there is no synchronous path, because `require` is CJS-only and `createRequire`
    cannot load an ESM TypeScript module under tsx. ADR 0018 sub-decision 7 already requires the schema
    to be frozen once before the first parse, so an `await` must land at the top of the load.

    The body change is small: resolve the location, `await` the registry build, call
    `makeWorkflowFileSchema(registry)`, then run the existing `visit()` recursion **unchanged and still
    synchronous** — `readFileSync` and `JSON.parse` stay exactly as they are.

    The alternative — keep `loadWorkflowTree` synchronous and have each caller `await` a registry and
    pass it in — was rejected because there are three callers
    (`packages/engine/src/cli.ts:356`, `packages/server/src/launch.ts:111`,
    `packages/server/src/routes/get-workflows.ts:73`) and splitting an assembly across callers who can
    disagree about it is the precise shape of the bug `Project` was created to end (#59/#64: the server
    passing the project directory where the engine wanted the workflow's own directory).

    The ripple is real and is accepted: `prepareWorkflow` and `handleGetWorkflows` are synchronous today
    and become async, along with their callers in `packages/server/src/create-server.ts`. The N per-call
    loads in `handleGetWorkflows` fold into one `Promise.all`, which also makes them concurrent.

    **Amended by the frozen-registry cutover.** As shipped, this sub-decision made `loadWorkflowTree` the
    sole freeze point for the *schema* only: it built a registry, froze the file schema, then discarded
    the registry. `runWorkflow` then scanned the folder a **second** time to build the executor registry
    it dispatched through, so a run's validity verdict and its dispatch rested on two separate reads of
    disk — usually identical (the mtime-keyed ESM cache, sub-decision 17), but with a window in which an
    edit between load and run makes them disagree, and a file could dispatch against a registry other than
    the one that validated it. The freeze point is now sole for **dispatch** too. The registry the load
    scans rides out on `LoadedWorkflow.registry` and threads into `runWorkflow` as `RunOptions.registry`;
    `runWorkflow` dispatches against it and never re-scans on the loaded path. Schema validity, the
    run-start config check (ADR 0022 sub-3), and leaf dispatch now key off one scan per run. `runWorkflow`
    keeps a self-scan **fallback** for a caller that reaches it without a load — an in-memory `WorkflowFile`
    from a test, or an embedder — so the "each caller awaits a registry and passes it in" hazard this
    sub-decision rejected never returns for the load path: the *load* is still the one assembler, and only
    a caller that skipped it scans for itself.

16. **A plugin present on disk but broken is a hard load failure, naming the folder and the reason.** The
    cases are a candidate directory with no `index.ts`, an `index.ts` that throws at import, a missing or
    malformed `stepPlugin` export, and a `fields` key colliding with `commonStepFields` (which ADR 0018
    sub-decision 4 already rejects at freeze).

    Skipping a broken plugin with a warning was rejected because it degrades into exactly the case ADR
    0018 sub-decision 5 says `@path/schema` **cannot** distinguish: the workflow then reports
    `Unknown step type "api-call" — no plugin contributes it` when the truth is that `api-call` is
    present and broken. #313 handed "present on disk but failed to load" to this ticket precisely so that
    message would have an owner. The accepted cost: one broken plugin fails every workflow, including
    ones that never name it. The surgical alternative — a third "known but unloadable" registry state
    that fails only on reference — buys a smaller blast radius for a deferred error path, and was
    declined for the same reason PATH fails loudly at load everywhere else.

    **Consequence drawn out by #315.** This blast radius reaches `GET /v0/workflows`, which calls
    `loadWorkflowTree` once per discovered file. One broken plugin folder therefore makes **every entry
    in the discovery list** read `valid: false`, files that never name the plugin included. Each entry's
    `error` still names the folder and the reason, so the list stays diagnosable, but the same message
    repeats N times and no entry is classifiable (`is_root: null`). #315 accepted this rather than carve
    a partial-success mode into the loader, which is the third registry state this sub-decision already
    declined.

### Freshness

17. **The registry is built per load, and a plugin is re-imported when its folder has changed.** Node's
    ESM cache cannot be invalidated, so the entry is imported as
    `` `${pathToFileURL(entry).href}?v=${token}` ``, where the token is the **maximum mtime across the
    plugin folder's tree**. An unchanged plugin produces the same URL and hits the cache: no
    re-execution, no new module record. So the module map grows with the number of *edits*, not the
    number of loads, and the N loads inside one `GET /v0/workflows` call share one import.

    The limit is stated rather than discovered, because Node does not propagate a query string to
    relative specifiers: `index.ts?v=2` importing `./helpers.ts` resolves to `.../helpers.ts` with no
    query, and hits the cached copy. **The entry module is refreshed on any change within its folder;
    modules the entry imports from beside it are refreshed only on process restart.** Requiring
    single-file plugins would remove the footnote at the cost of a real constraint on plugin authors,
    and was declined.

    One property falls out of this and is worth keeping: a run already in flight holds the worker
    functions it loaded, so an edit mid-run cannot swap code under a running step.

    No registry cache beyond Node's own module cache. ADR 0018 sub-decision 7 already accepts one schema
    construction per tree; N trees meaning N constructions is that same accepted cost. Memoizing by
    location is a pure optimization that changes nothing observable, and is deliberately left undecided
    here.

    **Consequence drawn out by #315.** Because the registry is rebuilt per load, a consumer that
    *receives* a registry rather than scanning for one — a browser design surface — holds a copy that can
    go stale mid-session. #315 pinned that copy as a **bare snapshot with no staleness contract**: it is
    not versioned, and no write is gated on it. `PUT /v0/workflows` keeps its ETag precondition on the
    file's bytes (ADR 0016) and the server re-validates against its own live registry, so a stale
    consumer's write fails as an ordinary schema error. That is the same stance as the in-flight property
    above, one layer out (ADR 0018 sub-decision 3, as amended).

## What this amends

- **ADR 0018 sub-decision 3** — "the empty registry reproduces today's built-in-only grammar exactly" no
  longer holds. Under sub-decision 10 an empty registry reproduces *nothing*: no `binary`, no `prompt`,
  and every existing workflow fails to load. The property does not disappear, it changes owner — the
  built-in grammar is now a fact about what ships in `packages/engine/step-plugins/`, not a property of
  `@path/schema`. `@path/schema`'s own purity is untouched: it still receives the registry as injected
  data and still reproduces exactly the grammar its input describes.
- **ADR 0018 sub-decision 6, and the #313 resolution's sub-decision 19** — the reserved-name set shrinks
  from eight names to six (sub-decision 14 above), and the check moves to scan time, before import. The
  two-set distinction those decisions drew survives and gets simpler: the reserved set is now exactly
  "the type names the walker owns", and the registry is exactly "everything discovered".
- **The #313 resolution's sub-decision 2** — `binary` and `prompt` are no longer "seeded by the engine
  before the folder scan". They are discovered by it. The property that sub-decision was protecting is
  untouched and in fact strengthened: leaf dispatch is still one registry lookup with no built-in branch,
  and now there is no seeding path beside the folder path either.

## Considered options

- **Anchor discovery on the project directory (`Project.dir`).** Rejected: `-C` sets it
  (`cli.ts:373`), so plugin resolution would become `-C`-relocatable and ADR 0005's "store-only"
  guarantee would be false. A shared central store would also impose one plugin set on every workflow
  filed under it.
- **Anchor on the workflow file's own directory.** Rejected: it keeps ADR 0005 intact but forces a copy
  of every plugin into every workflow-bearing directory, and leaves a nested-ref file able to resolve
  against a different registry standalone than under its parent (sub-decision 11).
- **Anchor on a discovered project root — walk up to the nearest ancestor holding `step-plugins/`.**
  Rejected in favour of the fixed location. It solved the copy problem and left `-C` alone, but it
  required a stop boundary for the walk, kept the standalone/nested divergence, and made the anchor a
  derived value that three callers would each have to derive identically.
- **A `plugin.json` manifest beside the entry module.** Rejected (sub-decision 1): it recreates the
  folder-name-versus-declared-type disagreement the folder contract exists to prevent.
- **Skip a broken plugin with a warning.** Rejected (sub-decision 16): the resulting workflow error is
  the one message ADR 0018 sub-decision 5 states the schema package cannot make truthful.
- **Keep `binary` and `prompt` engine-seeded and prove the loader with an acceptance fixture.** Rejected
  (sub-decision 10) once the fixed location made the engine's own directory the scanned one. The fixture
  proves the loader path; shipping the built-ins as folders proves the *contract*, against the hardest
  step type PATH has, continuously.
- **Cache-bust every import unconditionally, or not at all.** Rejected in both directions
  (sub-decision 17). Unconditional busting leaks a module record per load and can put two live copies of
  one plugin in one process; never busting means a plugin edit needs a server restart.

## Consequences

- **`packages/engine` gains a public plugin subpath**, `@path/engine/plugin`, re-exporting `z`,
  `defineStepPlugin`, and the `StepRequest` / `StepResult` types from the #313 seam. Its adequacy is
  load-bearing: the shipped `binary` and `prompt` plugins consume it, so a gap in it breaks PATH's own
  step types, not just a third party's.
- **`loadWorkflowTree` returns `Promise<LoadResult>`**, and `prepareWorkflow` and `handleGetWorkflows`
  become async with their callers in `create-server.ts`.
- **The scanned registry is the load's output, not just its schema's input** (frozen-registry cutover,
  amending sub-decision 15). `LoadedWorkflow` carries `registry`; `RunOptions.registry` threads it into
  `runWorkflow`, which dispatches against it and re-scans only on the load-less fallback path. The engine
  exports `LoadedStepPluginRegistry`, and the server's `StartRunOptions` / `ResumeRunOptions` carry it from
  the route's load through `LiveRuns` to `Project.run` / `Project.resume`. The redundant per-run scan and
  its divergence window are gone; a run dispatches against exactly the registry that validated its file.
- **[#319](https://github.com/howardyang2009/PATH/issues/319) grows materially.** Its title —
  migrate the built-ins to the worker-name model and remove the `engine|llm` union — now also covers
  physically relocating `packages/engine/src/binary-worker.ts` and
  `packages/engine/src/llm/agent-sdk-worker.ts` into `packages/engine/step-plugins/binary/` and
  `packages/engine/step-plugins/prompt/`, and rewriting them against the public subpath. #319 cannot
  decline that work without reopening sub-decision 10.
- **[#316](https://github.com/howardyang2009/PATH/issues/316)'s subject widens.** Secret-masking and
  trust for an in-process plugin now covers PATH's own shipped step types, since they run through the
  same seam by the same path. It may tighten #313's "a thrown exception propagates" stance; it cannot
  loosen it.
- **PATH's distribution model is fixed as clone-or-fork** (sub-decision 9), and publishing
  `@path/engine` as a package would require revisiting the plugin location first.
- **Plugin lifecycle and versioning stay open**, as #308 has them, but they are now bounded on one side.
  Sub-decision 1 fixes that a version, when it arrives, is a key in the entry module's export and never a
  second file. #315 adds the other bound: a plugin version is **observable, never requirable**. It may
  appear in provenance, diagnostics, and error text; no workflow file, config value, or operator input
  may pin or range over one, because #315 declined a `requires` block outright. Two versions of one type
  therefore cannot coexist in a registry — one folder, one name, one version.
  [#324](https://github.com/howardyang2009/PATH/issues/324) starts from "what is a version *for*, if
  nothing can demand one", not from "should files pin versions", which is answered. This is the constraint the map's circular #315/#324 coupling called for
  whichever ticket grilled first to hand over.
- **[#315](https://github.com/howardyang2009/PATH/issues/315) is resolved on this ADR's foundation.**
  Sub-decision 9's clone-or-fork distribution is what fixes the answer: a workflow file naming a plugin
  type is **portable within a fork lineage, not across forks**, because the plugin it needs lives in the
  reader's own PATH tree. #315 states that and adds no mechanism — no `requires` block (the `type` values
  in `body` are the dependency list), no `format` bump (the registry owns the type set, `format` owns the
  grammar shape), and no plugin data on source-workflow identity, which stays `{id, name, relative-path}`.
  A plugin type simply joins `relative-path` as the second thing in PATH that is brittle across machines;
  the file's `id` stays portable, and only its *loadability* was ever environment-relative. The record
  lands in ADR 0018 sub-decisions 3 and 5, [workflow-format-v2.md](../format/workflow-format-v2.md)
  §1/§4, [server-api-v0.md](../api/server-api-v0.md) §6, and CONTEXT.md.
