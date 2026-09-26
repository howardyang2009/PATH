# Blast radius: moving `packages/engine/step-plugins/` → `packages/engine/plugin/step-plugin/`

Research for issue [#560](https://github.com/howardyang2009/PATH/issues/560) (map [#558](https://github.com/howardyang2009/PATH/issues/558)). SPEC-ONLY: nothing was moved, renamed, or edited. All findings are grep/read against the working tree at branch `research/459-plugin-folder-blast-radius`.

## TL;DR

- **Exactly one functional path constant** drives discovery: `STEP_PLUGINS_DIR` in `packages/engine/src/plugin/scan.ts:34`, resolved from `import.meta.url` (`new URL("../../step-plugins/", import.meta.url)`), never `process.cwd()`.
- **The `binary` / `prompt` / `person-activity` folder paths are NOT hardcoded per-folder.** They are *computed* by `readdir(STEP_PLUGINS_DIR)` + `join(dir, name)` (`scan.ts:60,81`). Rename the base dir and all three (and any future plugin) follow automatically. The only per-folder hardcoding lives in **tests** (relative `import` specifiers) and in **human-facing hint strings**.
- **Workflow files are portable and unaffected.** A workflow file names a step by its `type` discriminant only; the folder is resolved engine-side from `import.meta.url`. ADR 0019 sub-8 explicitly *rejected* anchoring on the workflow-file directory or a project-root walk-up, so there is **no walk-up path constant** to fix and no `step-plugins/` copy embedded next to any workflow file.
- **The API route `GET /v0/step-plugins` is a separate identifier**, not the folder path. Moving the folder does **not** require renaming the route. ~20 route-name hits are listed separately as out-of-scope.
- The move target introduces a **naming clash risk**: `packages/engine` already has `src/plugin/` and a published subpath export `"./plugin": "./src/plugin/index.ts"` (`@path/engine/plugin`). A new top-level `packages/engine/plugin/` dir is a *different* location but reads as if related.

## Category 1 — Discovery / registry code (functional; MUST change)

| file:line | what | note |
|---|---|---|
| `packages/engine/src/plugin/scan.ts:34` | `export const STEP_PLUGINS_DIR = fileURLToPath(new URL("../../step-plugins/", import.meta.url))` | **The one load-bearing constant.** New target from `src/plugin/scan.ts` is still two dirs up, so it becomes `"../../plugin/step-plugin/"`. |
| `packages/engine/src/plugin/scan.ts:59-64,81` | `scanStepPlugins(dir = STEP_PLUGINS_DIR)` → `readdir(dir)` … `join(dir, name)` | subfolders computed, not hardcoded — no per-plugin edit needed here |
| `packages/engine/src/plugin/scan.ts:170` | docstring naming the route + folder | prose |
| `packages/engine/src/index.ts:36` | comment referencing `GET /v0/step-plugins` | prose (route name) |

## Category 2 — Build config / tsconfig (functional; MUST change)

| file:line | what | note |
|---|---|---|
| `packages/engine/tsconfig.json:9` | `"include": ["src", "test", "bin", "step-plugins"]` | **Must add the new path** or `tsc` stops emitting the plugins into `dist/`, breaking the built runtime. |
| `packages/engine/package.json` (exports `"./plugin"`) | not a `step-plugins` hit, but the target dir name `plugin/` collides conceptually with this subpath | naming-clarity risk, see TL;DR |

No root/workspace glob or vitest config references the folder (there is no `vitest.config.*`; the engine `test` script only excludes `**/dist/**`).

## Category 3 — The moved folder's own contents (move with the folder)

| path | note |
|---|---|
| `packages/engine/step-plugins/binary/index.ts` (self-ref comment at :7) | built-in plugin |
| `packages/engine/step-plugins/prompt/index.ts` (self-ref comment at :8) | built-in plugin |
| `packages/engine/step-plugins/prompt/deepseek-worker.ts` | worker |
| `packages/engine/step-plugins/prompt/render-prompt-message.ts` | helper |
| `packages/engine/step-plugins/person-activity/index.ts` | third built-in, real scanned plugin (see `docs/spec/person-activity.md:46`) |
| `packages/engine/step-plugins/.DS_Store` | stray macOS file, do not carry over |

## Category 4 — Tests: hardcoded imports & assertions (MUST change; break compile/run)

| file:line | what | note |
|---|---|---|
| `packages/engine/test/plugin-scan.test.ts:237` | `expect(STEP_PLUGINS_DIR).toMatch(/packages\/engine\/step-plugins\/?$/)` | **regex assertion on the path** — fails after move |
| `packages/engine/test/plugin-scan.test.ts:33` | comment | prose |
| `packages/engine/test/person-activity-plugin.test.ts:2` | `import … from "../step-plugins/person-activity/index.js"` | broken import |
| `packages/engine/test/step-plugins/prompt/anthropic-worker.test.ts:8` | `import … "../../../step-plugins/prompt/index.js"` | broken import |
| `packages/engine/test/step-plugins/prompt/deepseek-worker.test.ts:5` | `import … "../../../step-plugins/prompt/deepseek-worker.js"` | broken import |
| `packages/engine/test/step-plugins/prompt/deepseek-worker.test.ts:6` | `import type … "../../../step-plugins/prompt/index.js"` | broken import |
| `packages/engine/test/step-plugins/prompt/render-prompt-message.test.ts:2` | `import … "../../../step-plugins/prompt/render-prompt-message.js"` | broken import |
| `packages/engine/test/step-plugins/built-ins.test.ts:12,26,74` | comments referencing the real dir + route | prose |
| `packages/engine/test/complete.test.ts:14` | comment | prose |
| `packages/engine/test/acceptance/registry-cutover.test.ts:13` | comment `step-plugins/binary` `step-plugins/prompt` | prose |
| `packages/engine/test/acceptance/env-secret.test.ts:192` | comment `step-plugins/binary` | prose |
| `packages/engine/test/fixtures/plugin-contract/index.ts:3` | comment | prose |
| `packages/designer/test/open-workflow.test.ts:75,76,78,79` | asserts `toContain("packages/engine/step-plugins/api-call/")` etc. | **assertions on hint string** — update in lockstep with `open-workflow.ts:182` |
| `packages/schema/test/schema-factory.test.ts:94,103` | asserts `toContain("packages/engine/step-plugins/")` | **assertions on error-hint string** — update in lockstep with `nodes.ts:265-266` |

Note: the test *mirror* directory `packages/engine/test/step-plugins/` is a separate location (tests for the plugins), not the moved folder. Whether it is also renamed for consistency is a separate call; its `../../../step-plugins/...` imports break regardless.

## Category 5 — Human-facing hint / error strings (SHOULD change; else misleading)

These build the "create the folder here" remedy shown to authors. Functionally cosmetic, but wrong after the move.

| file:line | what |
|---|---|
| `packages/schema/src/nodes.ts:265` | `` `add a step-type plugin folder packages/engine/step-plugins/${received}/ in your PATH tree` `` |
| `packages/schema/src/nodes.ts:266` | `"add the step-type plugin folder for it under packages/engine/step-plugins/ in your PATH tree"` |
| `packages/designer/src/open-workflow.ts:182` | `` absent.push({ type, folder: `packages/engine/step-plugins/${type}/` }) `` |
| `packages/designer/src/open-workflow.ts:40` | doc comment for the `folder` field |
| `packages/schema/src/worker-names.ts:19` | comment `mirror packages/engine/step-plugins/prompt/index.ts` |
| `packages/server/src/routes/get-step-plugins.ts:8` | comment naming the folder |
| `packages/server/test/get-step-plugins.test.ts:32` | comment ("scans the real …/step-plugins/") |
| `packages/designer/src/palette-data.ts:8`, `use-open-file.ts:40` | comments (route + folder) |

## Category 6 — `dist/` build output (regenerated by `tsc`; stale until rebuild)

Not edited by hand. Listed so nobody chases them; they follow the source once tsconfig is fixed and the package is rebuilt.

| path | note |
|---|---|
| `packages/engine/dist/src/plugin/scan.js:10` | compiled `STEP_PLUGINS_DIR` (`"../../step-plugins/"`) — resolves to `dist/step-plugins/` at runtime |
| `packages/engine/dist/src/plugin/scan.js:127`, `dist/src/index.js:24` | compiled comments |
| `packages/engine/dist/step-plugins/**` | compiled built-ins (`binary/`, `prompt/`, `person-activity/`) — runtime target of the constant |
| `packages/engine/dist/test/step-plugins/**` | compiled plugin tests |
| `packages/schema/dist/src/nodes.js:199-200` | compiled hint strings |
| `packages/schema/dist/src/wire-step-plugins.*` | wire type (route-derived filename, not the folder) |
| `packages/client-core/dist/src/api-client.*` | route-name only |
| `packages/designer/dist/assets/index-B4kUv2uv.js:63,73,74` | **compiled hint string baked into the shipped browser bundle** (`packages/engine/step-plugins/${e}/`) — needs a designer rebuild to refresh |

## Category 7 — Docs / ADRs / narrative (prose; SHOULD change)

| file:line | note |
|---|---|
| `CONTEXT.md:118` | domain definition of "Step-type plugin" names the folder — **called out by the ticket** |
| `README.md:27,293` | folder path in prose (`:283` is route name) |
| `CHANGELOG.md:7` | folder path in prose |
| `docs/adr/0019-step-plugins-are-folders-under-packages-engine-step-plugins.md` | **ADR filename itself contains `step-plugins`**; body :1,28,83,260,281,314,315 |
| `docs/adr/0018-…:12,55,69` · `0020-…:7,107` · `0021-…:10,11,19,60,61,62,224` · `0023-…:6,48` · `0024-…:39` · `0026-…:39` · `0045-…:7` | cross-refs + body prose (`0044-…:168` is route name) |
| `docs/api/server-api-v0.md:572,703` | folder in prose (`:566,696,753` route) |
| `docs/format/workflow-format-v2.md:151` , `workflow-format-v3.md:161` | folder in prose (`:153/:163` route) |
| `docs/spec/designer-spec.md:242,355` (`:73,254` route) · `docs/spec/person-activity.md:46` | folder in prose |
| `docs/research/step-plugin-prior-art.md:5,28,367,371,377,413` · `zod-open-union.md:5,82,332` · `issue-462-debug-stepping-and-model-q.md:61,125` | generic `./step-plugins/` / person-activity path in prior research |
| `packages/designer/README.md:16` , `scripts/test/builtin-registry.ts:8` | prose |

## Category 8 — `/v0/step-plugins` route name & wire type (OUT of scope of the folder move)

These share the token `step-plugins` but name the **HTTP endpoint / wire projection**, independent of the folder location. Moving the folder does not require touching them (renaming the route would be a separate decision, and would touch far more).

`packages/server/src/create-server.ts:129,224` · `routes/get-step-plugins.ts` (filename) · `routes/post-runs.ts:35` · `packages/schema/src/wire-step-plugins.ts` (filename) `:6,54,110` + `index.ts:239` + `test/wire-step-plugins.test.ts` · `packages/client-core/src/api-client.ts:327,328,335` + `test/api-client.test.ts:322,335` · `packages/designer/test/stub-server.ts:5,67,122` · `packages/viewer/test/stub-server.ts:48,99` · `README.md:283` · `docs/api/server-api-v0.md:696`.

## Hit counts (source tree; excludes `dist/` duplicates, `.claude/` session logs, `node_modules`)

- Distinct source files touching the token `step-plugins`: **55** (per `grep -rln`, incl. route-name-only files).
- Functional path-dependent hits that break the build/tests if not changed: **`scan.ts:34`**, **`tsconfig.json:9`**, **5 broken test imports**, **3 assertion sites** (`plugin-scan.test.ts:237`, `open-workflow.test.ts` x1 block, `schema-factory.test.ts` x2) = the true "must-fix or CI red" set.
- Human-facing hint/error strings (misleading if left): **6** source sites (`nodes.ts` x2, `open-workflow.ts` x1, plus comments) + **1 shipped designer bundle** (`index-B4kUv2uv.js`).
- Docs/ADR/prose sites: **~20 files**, including the ADR-0019 filename.
- Route-name / wire-type hits (out of scope): **~13 files**.

## Migration-risk summary (top risks)

1. **Miss `tsconfig.json:9` and the build silently stops emitting the plugins.** `tsc` only compiles files under `include`. If the new path is not added, `dist/step-plugin/` is never produced, `STEP_PLUGINS_DIR` resolves to a missing dir, and every workflow load fails with "unknown step type" at runtime — not at compile time. Highest-severity, lowest-visibility.
2. **The `import.meta.url` relative offset must stay correct.** The constant is `../../` from `src/plugin/scan.ts`. Target `packages/engine/plugin/step-plugin/` is still two up from `src/plugin/`, so the literal becomes `"../../plugin/step-plugin/"`. Verify the compiled `dist/src/plugin/scan.js` still lands on the emitted plugin dir (dist layout mirrors `rootDir: "."`, so it becomes `dist/plugin/step-plugin/`). Both source and dist offsets must agree.
3. **Naming collision with the existing `./plugin` export and `src/plugin/`.** `@path/engine/plugin` (→ `src/plugin/index.ts`) is the public authoring seam; a new top-level `packages/engine/plugin/` for *plugin instances* is easy to confuse with it and with `src/plugin/` (the scanner). Consider whether `plugin/step-plugin/` is the intended shape or whether the seam/scanner dirs should be reconciled first.
4. **Two assertion pairs pin the exact hint string** (`schema-factory.test.ts:94,103` ↔ `nodes.ts:265-266`; `open-workflow.test.ts:75-79` ↔ `open-workflow.ts:182`). Change source and test together or CI goes red; leave the strings and authors are told to create a folder that no longer exists.
5. **The shipped designer browser bundle bakes the old path** (`packages/designer/dist/assets/index-B4kUv2uv.js`). A source edit is invisible to users until the designer is rebuilt and redeployed.
6. **Low risk, easy to over-scope:** the `/v0/step-plugins` route and `wire-step-plugins.ts` look like folder references but are not. Renaming them is *not* required by the folder move; bundling that in would expand the diff across server + client-core + designer + viewer + docs for no functional reason.
7. **No workflow-file portability breakage.** Confirmed: workers resolve their own relative paths against the workflow file's directory (`packages/engine/src/plugin/resolve-against-workflow-dir.ts`), and step *types* resolve through the scanned registry, not a path written in the workflow file. Existing `.workflow.json` files need no change.
