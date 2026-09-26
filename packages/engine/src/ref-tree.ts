import { dirname, resolve } from "node:path";
import { walkNodes, type ConfigObject, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { effectiveConfig, type EnvSource } from "./resolve-env.js";

/**
 * The **loaded ref tree** (CONTEXT.md § Workflow): one root `workflow.json` plus every file its nested
 * `workflow` steps reach, each level's `ref` resolved against *that level's own directory*.
 *
 * **What this module exists to own.** Four readers used to descend that tree themselves: the run-start
 * config gate (`validateRunStartConfig`), the Complete door's node lookup (`resolveNode`), the nested
 * run's dispatch (`runWorkflowNode`) and the Rerun-boundary descent (`descendNodePath`). "Resolve the
 * `ref` against this level's dir and thread the effective config across the file seam" was therefore
 * written four times, under two signatures for identical inputs — and the copies could disagree, which
 * they did: `resolveNode`'s default environment is a fresh `process.env`, not the run's own snapshot.
 *
 * One walk answers every reader's question from one place: {@link walkRefTree} yields every node with
 * the config that actually reaches it, and {@link resolveChildRef} answers the `ref` question alone,
 * for the two readers that need a child rather than an enumeration.
 */

/** A resolved nested-`workflow` reference: the child file and the directory its own `ref`s resolve against. */
export interface ChildRef {
  file: WorkflowFile;
  /** The child file's own directory — `dirname` of the resolved path, which a grandchild resolves against. */
  dir: string;
}

/**
 * One node of the loaded ref tree, with the config that reaches it. `stepConfig` is the node's own
 * effective config — this level's file config merged with the node's `config` fragment, `$env` resolved
 * and `$secret` unwrapped (`resolveEffectiveConfig`) — literally the object `runNode` hands a worker,
 * so a reader that validates or interpolates against it reads what the run reads.
 */
export interface RefTreeEntry {
  /** The file the node lives in (the root file at the top level, a descended child below). */
  file: WorkflowFile;
  /** That file's directory. */
  dir: string;
  node: WorkflowNode;
  /** The effective config reaching this node, exactly as dispatch materializes it. */
  stepConfig: ConfigObject;
}

/** What a walk needs to resolve `$env`, thread operator overrides, and reach nested files. */
export interface RefTreeScope {
  /**
   * Every workflow file reachable from the root via `workflow` refs, keyed by absolute path
   * (`loadWorkflowTree`'s output). Absent when the workflow has no `workflow` steps, or when a caller
   * built a `WorkflowFile` in memory — a `ref` then simply does not resolve.
   */
  files?: Map<string, WorkflowFile>;
  /** The operator's launch-time config, the first merge term at the root level (spec §3). */
  operatorConfig?: ConfigObject;
  /** The run's one environment snapshot (#116); `$env` values resolve against it. */
  env: EnvSource;
}

/**
 * Resolve one `workflow` node's `ref` against its own level's `dir`, or `undefined` when the loaded
 * tree does not hold that file (or holds no tree at all). The one spelling of the engine's ref math:
 * `resolve(dir, ref)` for the lookup key, `dirname` of it for the child's own level.
 */
export function resolveChildRef(dir: string, ref: string, files: Map<string, WorkflowFile> | undefined): ChildRef | undefined {
  if (files === undefined) return undefined;
  const path = resolve(dir, ref);
  const file = files.get(path);
  return file === undefined ? undefined : { file, dir: dirname(path) };
}

/**
 * Every node of the loaded ref tree, depth-first in body order, each with the effective config that
 * reaches it. A `workflow` node is yielded like any other and then descended into — its child inherits
 * this step's effective config across the boundary (format §8) — so a file reached under two parents is
 * visited once per incoming config, each with what actually reaches it.
 */
export function* walkRefTree(rootFile: WorkflowFile, rootDir: string, scope: RefTreeScope): Generator<RefTreeEntry> {
  function* walk(file: WorkflowFile, incomingConfig: ConfigObject, dir: string): Generator<RefTreeEntry> {
    const fileConfig = effectiveConfig(file.config ?? {}, incomingConfig, scope.env);
    for (const node of walkNodes(file.body)) {
      const nodeConfig = "config" in node ? node.config : undefined;
      const stepConfig = effectiveConfig(fileConfig, nodeConfig, scope.env);
      yield { file, dir, node, stepConfig };
      if (node.type === "workflow") {
        const child = resolveChildRef(dir, node.ref, scope.files);
        if (child) yield* walk(child.file, stepConfig, child.dir);
      }
    }
  }
  yield* walk(rootFile, scope.operatorConfig ?? {}, rootDir);
}

/** A node found by id in a loaded ref tree, with the effective config that reaches it. */
export interface ResolvedNode {
  /** The node exactly as it stands in the current file. */
  node: WorkflowNode;
  /**
   * The `config` scope a caller interpolates this node's fields against — the file's config merged
   * with the node's own, `$env`-resolved and `$secret` unwrapped (`resolveEffectiveConfig`), exactly
   * the object `runLeafStep` interpolates fields against at execution time.
   */
  config: ConfigObject;
}

/**
 * Locate a node by its durable GUID `id` across the loaded ref tree, threading effective config
 * across each `workflow` boundary exactly as the run will (`validateRunStartConfig`, format §8) — so
 * the config a caller interpolates a field against here is the one the run itself used. `undefined`
 * when no reachable file carries a node with that id (the author deleted it mid-wait).
 *
 * The Complete route (#485) reads a parked `person-activity` leaf's `outputSchema` through this,
 * re-interpolates it against config, and ajv-validates the submitted output (ADR 0040) — all before
 * any lease is taken, so a bad submit never blocks a sibling leaf.
 */
export function resolveNode(
  rootFile: WorkflowFile,
  rootDir: string,
  nodeId: string,
  options: { files?: Map<string, WorkflowFile>; operatorConfig?: ConfigObject; env?: EnvSource } = {},
): ResolvedNode | undefined {
  // The one descent of the loaded tree (`walkRefTree`), so the config a caller interpolates this node's
  // fields against is the object dispatch hands the worker — one rule, not a second copy of it. The
  // caller owns the environment snapshot (`RunOptions`/`Project`), because a reader that takes its own
  // `process.env` here would judge the node against config the run never used.
  const scope = {
    files: options.files,
    operatorConfig: options.operatorConfig,
    env: options.env ?? { ...process.env },
  };
  for (const entry of walkRefTree(rootFile, rootDir, scope)) {
    if (entry.node.id === nodeId) return { node: entry.node, config: entry.stepConfig };
  }
  return undefined;
}
