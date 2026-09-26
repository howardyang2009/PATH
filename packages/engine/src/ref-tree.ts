import { dirname, resolve } from "node:path";
import { type ConfigObject, type WorkflowFile, type WorkflowNode, walkNodes } from "@path/schema";
import { type EnvSource, effectiveConfig } from "./resolve-env.js";

/**
 * The loaded ref tree: one root `workflow.json` plus every file its nested `workflow` steps reach, each level's `ref`
 * resolved against that level's own directory, with the config that reaches each node.
 */

/** A resolved nested-`workflow` reference: the child file and the directory its own `ref`s resolve against. */
export interface ChildRef {
  file: WorkflowFile;
  dir: string;
}

/** One node of the loaded ref tree, with the config that reaches it. */
export interface RefTreeEntry {
  file: WorkflowFile;
  /** That file's directory. */
  dir: string;
  node: WorkflowNode;
  /** The effective config reaching this node, exactly as dispatch materializes it. */
  stepConfig: ConfigObject;
}

/** What a walk needs to resolve `$env`, thread operator overrides, and reach nested files. */
export interface RefTreeScope {
  /** Every workflow file reachable from the root, keyed by absolute path; absent when a `ref` cannot resolve. */
  files?: Map<string, WorkflowFile>;
  /** The operator's launch-time config, the first merge term at the root level (spec §3). */
  operatorConfig?: ConfigObject;
  /** The run's one environment snapshot; `$env` values resolve against it. */
  env: EnvSource;
}

/**
 * Resolve one `workflow` node's `ref` against its own level's `dir`, or `undefined` when the loaded tree holds no
 * such file.
 */
export function resolveChildRef(
  dir: string,
  ref: string,
  files: Map<string, WorkflowFile> | undefined,
): ChildRef | undefined {
  if (files === undefined) return undefined;
  const path = resolve(dir, ref);
  const file = files.get(path);
  return file === undefined ? undefined : { file, dir: dirname(path) };
}

/**
 * Every node of the loaded ref tree, depth-first in body order, each with the config that reaches it; a `workflow`
 * node is yielded then descended, its child inheriting this step's config.
 */
export function* walkRefTree(
  rootFile: WorkflowFile,
  rootDir: string,
  scope: RefTreeScope,
): Generator<RefTreeEntry> {
  function* walk(
    file: WorkflowFile,
    incomingConfig: ConfigObject,
    dir: string,
  ): Generator<RefTreeEntry> {
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
  node: WorkflowNode;
  /** The `config` scope a caller interpolates this node's fields against, exactly what `runLeafStep` uses. */
  config: ConfigObject;
}

/**
 * Locate a node by its durable GUID `id` across the loaded ref tree, with the config the run interpolates;
 * `undefined` when no reachable file carries it (deleted mid-wait).
 */
export function resolveNode(
  rootFile: WorkflowFile,
  rootDir: string,
  nodeId: string,
  options: {
    files?: Map<string, WorkflowFile>;
    operatorConfig?: ConfigObject;
    env?: EnvSource;
  } = {},
): ResolvedNode | undefined {
  // The caller owns the environment snapshot: a fresh `process.env` here would judge the node against config the run
  // never used.
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
