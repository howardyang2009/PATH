import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { codedMessage, type Message, verbatim } from "@path/i18n";
import {
  duplicateIdIssues,
  makeWorkflowFileSchema,
  safeParseWorkflowFileWith,
  type WorkflowFile,
  type WorkflowNode,
  walkNodes,
} from "@path/schema";
import { type LoadedStepPluginRegistry, scanStepPlugins } from "./plugin-seam/scan.js";

/**
 * One workflow, loaded: the entry file itself, where it sits, and every file it reaches. Everything
 * derivable from the load is derived here, once, so no caller re-derives the root file, the
 * directory refs resolve against, or the store-relative provenance path.
 */
export interface LoadedWorkflow {
  rootPath: string;
  rootFile: WorkflowFile;
  /**
   * The entry file's **own** directory, never the project directory: `-C` relocating a store must
   * not re-root the workflow (ADR 0005).
   */
  workflowDir: string;
  files: Map<string, WorkflowFile>;
  /**
   * The frozen registry this load scanned to build the schema (ADR 0019 sub-15). `runWorkflow`
   * takes it as `RunOptions.registry`, so a run dispatches against exactly the registry its file
   * was validated against, with no window in which an edit between load and run splits verdict from
   * dispatch.
   */
  registry: LoadedStepPluginRegistry;
  /** The entry file's path relative to `storeDir` — the root run's `workflow_path` provenance (ADR
   * 0006). */
  storeRelativePath(storeDir: string): string;
}

export type LoadResult =
  | { success: true; workflow: LoadedWorkflow }
  | { success: false; issues: Message[] };

/** `issue` about the file at `absPath`, as one line of a load failure. */
function atFile(absPath: string, issue: Message): Message {
  return { key: "shared.issueAtPath", params: { path: absPath, issue } };
}

// A `workflow` step's ref can sit at any nesting depth, so this walks the whole body with
// @path/schema's descent; restating the descent would let a new block type hide a file.
function collectWorkflowRefs(nodes: WorkflowNode[]): string[] {
  const refs: string[] = [];
  for (const node of walkNodes(nodes)) {
    if (node.type === "workflow") refs.push(node.ref);
  }
  return refs;
}

export interface LoadWorkflowTreeOptions {
  /** Whether a `ref` may reach the absolute path it resolves to; a refused ref fails the load,
   * named. Without it, every ref is followed. */
  refAllowed?(absPath: string): boolean;
}

export async function loadWorkflowTree(
  entryPath: string,
  { refAllowed = () => true }: LoadWorkflowTreeOptions = {},
): Promise<LoadResult> {
  const files = new Map<string, WorkflowFile>();
  const issues: Message[] = [];

  // The one freeze point (ADR 0019 sub-15): scan the plugin folder into a registry and build the
  // file schema once, before the first parse. A broken plugin folder fails the whole load naming
  // the folder and the reason (ADR 0019 sub-16) rather than becoming a per-file error, because a
  // skipped plugin is indistinguishable from a genuinely absent type. `RunOptions.registry` is the
  // same frozen registry.
  const registry = await scanStepPlugins();
  const schema = makeWorkflowFileSchema(registry);

  function visit(absPath: string, chain: string[]): void {
    if (chain.includes(absPath)) {
      issues.push(
        codedMessage("workflow.load.ref-cycle", { chain: [...chain, absPath].join(" -> ") }),
      );
      return;
    }

    if (files.has(absPath)) return; // shared ref already fully loaded outside this chain

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(absPath, "utf8"));
    } catch (err) {
      issues.push(atFile(absPath, verbatim(err instanceof Error ? err.message : String(err))));
      return;
    }

    const parsed = safeParseWorkflowFileWith(schema, raw);
    if (!parsed.success) {
      issues.push(...parsed.issues.map((issue) => atFile(absPath, issue)));
      return;
    }
    const duplicates = duplicateIdIssues(parsed.data);
    if (duplicates.length > 0) {
      issues.push(...duplicates.map((issue) => atFile(absPath, issue)));
      return;
    }

    files.set(absPath, parsed.data);

    for (const ref of collectWorkflowRefs(parsed.data.body)) {
      const target = resolve(dirname(absPath), ref);
      if (refAllowed(target)) visit(target, [...chain, absPath]);
      else issues.push(atFile(absPath, codedMessage("workflow.load.ref-outside", { ref })));
    }
  }

  const rootPath = resolve(entryPath);
  visit(rootPath, []);

  if (issues.length > 0) return { success: false, issues };

  const rootFile = files.get(rootPath);
  if (!rootFile) {
    return {
      success: false,
      issues: [atFile(rootPath, codedMessage("workflow.load.entry-missing"))],
    };
  }

  return {
    success: true,
    workflow: {
      rootPath,
      rootFile,
      workflowDir: dirname(rootPath),
      files,
      registry,
      storeRelativePath: (storeDir: string) => relative(storeDir, rootPath),
    },
  };
}
