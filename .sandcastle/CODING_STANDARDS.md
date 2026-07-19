# Coding Standards

<!-- The reviewer agent loads this file during code review via @.sandcastle/CODING_STANDARDS.md
     so these standards are enforced during review without costing tokens during implementation. -->

## Language & terminology

- CONTEXT.md at the repo root is the canonical glossary (ubiquitous language). Code, tests, comments, and commit messages use its terms exactly: Step, Worker, Task, Run, Processor, Workflow, Logicer, Checkpoint, Config, Context, Log event, Trace.
- Do not invent synonyms — e.g. there is no "workflow execution", only a Run; "task = step + worker" is a definition, not a loose phrase.

## Style

- TypeScript, strict mode, ESM. Relative imports include the `.js` extension (`import { IdSchema } from "./ids.js"`).
- File names are kebab-case (`load-workflow-tree.ts`, `workflow-file-type.ts`). Pure type modules use a `-type.ts` suffix alongside their schema module (`nodes.ts` / `node-type.ts`).
- camelCase for variables/functions, PascalCase for types and Zod schemas, SCREAMING_SNAKE_CASE for module-level constants.
- Named exports only; no default exports.
- Zod schemas are named `XxxSchema` and object schemas are `.strict()` — unknown keys are validation errors.
- Comments explain constraints, not mechanics, and cite spec sections where relevant (e.g. `workflow-format-v0.md §4.2`).

## Testing

- Vitest. Tests live in each package's `test/` directory, named `<module>.test.ts` after the module under test.
- Every new behavior in @path/schema or @path/engine gets a test; validation logic is tested for both the accepting and the rejecting case.
- Run `pnpm typecheck` and `pnpm test` from the repo root before committing (they recurse into all workspace packages).

## Architecture

- Monorepo: `@path/schema` owns workflow-format types + validation; `@path/engine` owns execution, persistence, and the CLI. Schema must not depend on engine.
- The engine persists run records and blobs under `.path/`; masking of secrets happens at the persistence boundary, never in worker-facing dataflow.
- Config flows in from outside; Context is written from inside — do not blur the two.
- This is a pnpm workspace: use `pnpm` (never `npm`/`yarn`) for installs and scripts; add package-scoped deps with `pnpm add <pkg> --filter @path/<name>`.
