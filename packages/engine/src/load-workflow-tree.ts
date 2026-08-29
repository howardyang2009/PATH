import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { makeWorkflowFileSchema, safeParseWorkflowFileWith, walkNodes, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { scanStepPlugins } from "./plugin/scan.js";

/**
 * One workflow, loaded: the entry file itself, where it sits, and every file it reaches.
 *
 * **What this interface exists to own.** It used to be `{ rootPath, files }`, and every caller
 * re-derived the same three facts from the pair: the root file (`files.get(rootPath)`, plus a
 * "missing from the loaded tree" branch none of them could reach), the directory the engine
 * resolves nested `ref`s and binary `cwd`s against (`dirname(rootPath)`), and the store-relative
 * path a root run records as provenance (`relative(storeDir, rootPath)`). Eight sites did it —
 * `cli.ts`, three `@path/server` routes, and four tests — which is what made the project-dir /
 * workflow-dir confusion of #59 available to be made at all.
 *
 * Everything derivable from the load is derived here, once. `files` stays public because the
 * engine genuinely indexes it (`RunOptions.files`, a `workflow` step resolving its `ref`), and
 * `rootPath` because discovery compares it against paths of its own (`get-workflows.ts`).
 */
export interface LoadedWorkflow {
  /** Absolute path of the entry file passed to `loadWorkflowTree`. */
  rootPath: string;
  /**
   * The parsed entry file — where a run starts. Guaranteed present: a load that could not read or
   * parse the entry file fails, so no caller carries a missing-root branch of its own.
   */
  rootFile: WorkflowFile;
  /**
   * The entry file's **own** directory — what the engine resolves nested `workflow` refs and binary
   * `cwd`s against (`Project.run`'s `workflowDir`). Never the project directory, whose `.path/` is
   * a separate question: passing that here is what broke nested refs in #59, and `-C` relocating a
   * store must not re-root the workflow (ADR 0005).
   */
  workflowDir: string;
  /** Every file reachable from the root via `workflow` step refs, keyed by absolute path. */
  files: Map<string, WorkflowFile>;
  /**
   * The entry file's path relative to `storeDir` — the root run's `workflow_path` provenance (#202,
   * ADR 0006), which is how a central `-C` store segments runs by the workflow that produced them.
   * A call rather than a field because the store dir is the caller's (a CLI `-C`, the server's
   * project root) while the absolute path it is measured from is the load's.
   */
  storeRelativePath(storeDir: string): string;
}

export type LoadResult = { success: true; workflow: LoadedWorkflow } | { success: false; errors: string[] };

// A `workflow` step's ref can sit inside any nesting of control blocks, so this walks the whole
// body — using @path/schema's descent rather than restating it, which is what let a new block type
// silently hide a nested file from the loader (#70).
function collectWorkflowRefs(nodes: WorkflowNode[]): string[] {
  const refs: string[] = [];
  for (const node of walkNodes(nodes)) {
    if (node.type === "workflow") refs.push(node.ref);
  }
  return refs;
}

export async function loadWorkflowTree(entryPath: string): Promise<LoadResult> {
  const files = new Map<string, WorkflowFile>();
  const errors: string[] = [];

  // The one freeze point (ADR 0018 sub-7, ADR 0019 sub-15): scan the plugin folder into a registry and
  // build the file schema once, before the first parse. A broken plugin folder throws here and fails
  // the whole load naming the folder and the reason (ADR 0019 sub-16) — it is not caught into a
  // per-file error, because a skipped plugin is indistinguishable from a genuinely absent type. The
  // `visit()` recursion below stays synchronous — `readFileSync`/`JSON.parse` unchanged.
  const registry = await scanStepPlugins();
  const schema = makeWorkflowFileSchema(registry);

  function visit(absPath: string, chain: string[]): void {
    if (chain.includes(absPath)) {
      errors.push(`ref cycle: ${[...chain, absPath].join(" -> ")}`);
      return;
    }

    if (files.has(absPath)) return; // shared ref already fully loaded outside this chain

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(absPath, "utf8"));
    } catch (err) {
      errors.push(`${absPath}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const parsed = safeParseWorkflowFileWith(schema, raw);
    if (!parsed.success) {
      errors.push(...parsed.errors.map((e) => `${absPath}: ${e}`));
      return;
    }

    files.set(absPath, parsed.data);

    for (const ref of collectWorkflowRefs(parsed.data.body)) {
      visit(resolve(dirname(absPath), ref), [...chain, absPath]);
    }
  }

  const rootPath = resolve(entryPath);
  visit(rootPath, []);

  if (errors.length > 0) {
    return { success: false, errors };
  }

  // `visit` either records the entry file or pushes an error, and every error path returned above —
  // so this is unreachable. It stays as the *one* place that says so: it used to be a branch each
  // caller wrote out, guarding against a state the loader had already ruled out for them.
  const rootFile = files.get(rootPath);
  if (!rootFile) {
    return { success: false, errors: [`${rootPath}: internal error: entry file missing from the loaded tree`] };
  }

  return {
    success: true,
    workflow: {
      rootPath,
      rootFile,
      workflowDir: dirname(rootPath),
      files,
      storeRelativePath: (storeDir: string) => relative(storeDir, rootPath),
    },
  };
}
