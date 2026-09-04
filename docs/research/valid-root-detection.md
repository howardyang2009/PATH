# Valid-root detection — can the loader tell a nested `workflow` ref from a true root?

Research for wayfinder ticket [#229](https://github.com/howardyang2009/PATH/issues/229). A directory
scanner discovers every `workflow.json` under a tree and wants to list **only true roots**, and drop
files that are merely a nested `workflow` step's `ref` target of some other workflow. The question is
whether `@path/engine`'s loader already surfaces the nested-ref set so the scanner can subtract it from
the union of all discovered files.

Short answer: **yes**, and the primitives already exist. `loadWorkflowTree` returns the transitive set
of files reachable from a root through `workflow` refs, keyed by absolute path. Subtract each loaded tree's
`files` keys (minus its own root) from the union of discovered files, and what remains are the true
roots. The refs are schema-guaranteed relative, so path-set subtraction is sound, with the
canonicalization and cycle/symlink caveats in the last section.

## 1. Does a loaded tree expose the nested-ref child paths?

Yes. `loadWorkflowTree(entryPath)` returns `LoadResult`, a discriminated union. On success, `tree` is a
`WorkflowTree`:

- `tree.rootPath: string` — the entry file's absolute path (`resolve(entryPath)`).
  [`packages/engine/src/load-workflow-tree.ts:7`](../../packages/engine/src/load-workflow-tree.ts#L7),
  set at [`load-workflow-tree.ts:58`](../../packages/engine/src/load-workflow-tree.ts#L58).
- `tree.files: Map<string, WorkflowFile>` — **every file reachable from the root through `workflow` step
  refs, keyed by absolute path.**
  [`load-workflow-tree.ts:9`](../../packages/engine/src/load-workflow-tree.ts#L9).

**How to read the child paths off it:** the map is the *transitive closure* of the root plus all its
nested-ref descendants. So the nested-ref set for one root is simply:

```
childPaths(root) = new Set(tree.files.keys())  minus  tree.rootPath
```

There is no separate explicit edge list; the closure is flattened into the keys. Each `workflow` step's
child is discovered at
[`load-workflow-tree.ts:53-55`](../../packages/engine/src/load-workflow-tree.ts#L53). `collectWorkflowRefs`
walks the file's whole `body` (through every control block, with `@path/schema`'s `walkNodes`) and pulls
each `node.ref` where `node.type === "workflow"`
([`load-workflow-tree.ts:17-23`](../../packages/engine/src/load-workflow-tree.ts#L17)). Then each ref is
resolved against the referencing file's directory (`resolve(dirname(absPath), ref)`) and visited
recursively ([`load-workflow-tree.ts:54`](../../packages/engine/src/load-workflow-tree.ts#L54)).
`walkNodes` deliberately does **not** descend into a `workflow` step's ref'd file
([`packages/schema/src/node-walk.ts:30`](../../packages/schema/src/node-walk.ts#L30): "Deliberately does
not descend into a `workflow` step's ref'd file"). The recursion in `visit()` is what makes `tree.files`
transitive.

**Scanner algorithm.** For a directory of discovered files `D` (each canonicalized the same way the
loader keys them, see caveats):

```
nested = union over d in D of ( keys(load(d).tree.files) \ {resolve(d)} )
trueRoots = D \ nested
```

Every file that is a nested ref of *any* discovered workflow lands in `nested` and is dropped. Whatever
no one refs is a true root. Because keys are absolute paths, a shared child referenced from several roots
collapses to one key (the loader itself dedups through
[`load-workflow-tree.ts:35`](../../packages/engine/src/load-workflow-tree.ts#L35),
`if (files.has(absPath)) return;`).

## 2. Is there a static "valid root workflow" check (load + validate without running)?

Yes. `loadWorkflowTree` **is** that check. It reads and schema-validates the whole file tree and never
executes a step. It fails (`{ success: false, errors }`) on: unreadable/invalid JSON
([`load-workflow-tree.ts:37-43`](../../packages/engine/src/load-workflow-tree.ts#L37)), any
`@path/schema` violation through `safeParseWorkflowFile`
([`load-workflow-tree.ts:45-49`](../../packages/engine/src/load-workflow-tree.ts#L45)), and **ref
cycles** ([`load-workflow-tree.ts:30-33`](../../packages/engine/src/load-workflow-tree.ts#L30)).
Unresolvable refs surface as the read error at line 39. This mirrors the format's normative load-time
contract: the engine "loads the whole file tree (following `ref`s) before any step runs, and rejects"
schema violations, cycles, and unresolvable `ref` paths
([`docs/format/workflow-format-v0.md:312-316`](../format/workflow-format-v0.md#L312)).

There is **no dedicated `validate` subcommand**. The CLI dispatches only `run` and `runs`
([`packages/engine/src/cli.ts:694`](../../packages/engine/src/cli.ts#L694),
[`cli.ts:697`](../../packages/engine/src/cli.ts#L697)). Both the CLI `run`
([`cli.ts:335`](../../packages/engine/src/cli.ts#L335)) and the server's `POST /runs`
([`packages/server/src/routes/post-runs.ts:68`](../../packages/server/src/routes/post-runs.ts#L68)) call
`loadWorkflowTree` for exactly this load-then-run gate, and `run-workflow` consumes the resulting `files`
map rather than re-read it
([`packages/engine/src/run-workflow.ts:37`](../../packages/engine/src/run-workflow.ts#L37)).
`loadWorkflowTree` is exported from the package index
([`packages/engine/src/index.ts:1`](../../packages/engine/src/index.ts#L1)), so a scanner can call it
directly. "Valid root" means `loadWorkflowTree(candidate).success === true`.

## 3. Are nested `workflow` refs always relative paths?

**Yes. The schema forbids absolute paths, and every ref is resolved as a relative filesystem path.** The
`workflow` step's `ref` is a `RefSchema`: a non-empty string refined to reject a leading `/`
([`packages/schema/src/nodes.ts:41-44`](../../packages/schema/src/nodes.ts#L41)):

```ts
const RefSchema = z.string().min(1)
  .refine((value) => !value.startsWith("/"), { message: "ref must be a relative path, not absolute" });
```

The comment above it states the intent: "`ref` is a relative path to another workflow file — not an
interpolated position" ([`nodes.ts:39`](../../packages/schema/src/nodes.ts#L39)). The format doc is
normative: "`ref` (string, *not* interpolable) is a relative path to another workflow file, resolved
against the directory of the referencing file"
([`docs/format/workflow-format-v0.md:107-108`](../format/workflow-format-v0.md#L107)). §5 lists `ref`
among the *inert* (non-interpolated) positions
([`workflow-format-v0.md:148`](../format/workflow-format-v0.md#L148)), so there is no `${...}`-driven
dynamic ref either.

There is **no bare-package or URL form.** The schema only bans a leading `/`. A string like `https://x`
or `pkg/foo` passes the refine, but is then fed straight into `resolve(dirname(absPath), ref)`
([`load-workflow-tree.ts:54`](../../packages/engine/src/load-workflow-tree.ts#L54)), that is, treated as
a relative path segment under the referencing file's directory. There is no package resolver and no URL
fetch anywhere in the loader. Such a ref simply resolves to a bogus local path and fails the read at
[`load-workflow-tree.ts:39`](../../packages/engine/src/load-workflow-tree.ts#L39). So every ref that
loads successfully is a genuine relative filesystem path, and path-set subtraction over absolute-resolved
keys is sound.

## Gotchas for the discovery algorithm

- **Same file referenced by multiple roots** — safe. The loader keys by absolute path and dedups
  ([`load-workflow-tree.ts:35`](../../packages/engine/src/load-workflow-tree.ts#L35)). Across trees, the
  same absolute key subtracts once. No double-counting.

- **A file that is BOTH a standalone valid root and a nested ref elsewhere** — this is the crux of "valid
  roots only." Such a file loads fine on its own (it *is* a valid root by the §2 check), yet it appears
  in another root's `tree.files`. The algorithm in §1 will (correctly, per the ticket's "not referenced
  by another" definition) place it in `nested` and drop it from `trueRoots`. The loader cannot infer
  *intent*; it only reports reachability. If the ticket's real intent is "top of its own dependency
  chain" rather than "unreferenced," that policy call has to live in the scanner, not the loader.

- **Cycles** — a ref cycle (`A` refs `B` refs `A`) makes `loadWorkflowTree` **fail** for every entry on
  the cycle ([`load-workflow-tree.ts:30-33`](../../packages/engine/src/load-workflow-tree.ts#L30)). On
  failure, `LoadResult` carries no `tree`, so there are *no* child paths to read off it. A scanner must
  treat a failed load as "cannot classify" (not "is a root" and not "has no children") rather than a read
  of `tree.files` off a non-existent tree.

- **Symlinks / path aliasing** — the loader canonicalizes with `path.resolve`
  ([`load-workflow-tree.ts:54,58`](../../packages/engine/src/load-workflow-tree.ts#L54)), which is
  **lexical only** (it collapses `..` and `.` but does **not** call `realpath`). Two paths that reach the
  same file through a symlink or a `../` detour produce **different** map keys, so string subtraction can
  miss a match and mis-list a nested file as a root. The scanner must canonicalize its discovered paths
  **the same lexical way** the loader does (`path.resolve`). If symlinks are in play, `realpath` **both**
  the discovered set and the `tree.files` keys consistently before subtraction.

- **Relative-path soundness** — because §3 guarantees refs resolve to local relative paths under the
  referencing directory, the union-subtraction is well-defined: every child key is a real path that can
  coincide with a discovered file's path. If refs could be URLs or package names this would not hold, but
  they cannot.
