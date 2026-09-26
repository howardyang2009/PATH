import { type ConfigObject, formatIssues, type WorkflowFile, walkNodes } from "@path/schema";
import { z } from "zod";
import { describeMissingLaunchSecrets } from "./launch-facts.js";
import { type LoadedStepPluginRegistry, scanStepPlugins } from "./plugin/scan.js";
import { walkRefTree } from "./ref-tree.js";
import { describeUnsetEnv, type EnvSource, resolveRunEnv } from "./resolve-env.js";
import type { RunOptions, WorkerOverrides } from "./run-workflow.js";
import { collectSecrets, type SecretMasker } from "./secret-mask.js";

/** Run start: the frozen executor registry a root run dispatches against, and one read of the whole
 * config tree yielding the secret masker and the run-start gate's verdict. */

/** The frozen executor registry for one run, with `workerOverrides` merged over it replace-only
 * (ADR 0021 sub-15): an override naming a `(type, name)` pair the scan did not produce is a hard error,
 * never an insertion. With no load the folder is scanned here, and plugins are shallow-cloned so a
 * replacement never mutates the load's frozen registry (ADR 0019 sub-2). */
export async function resolveExecutorRegistry(
  provided: LoadedStepPluginRegistry | undefined,
  overrides: WorkerOverrides | undefined,
  stepPluginsDir: string | undefined,
): Promise<LoadedStepPluginRegistry> {
  const base = provided ?? (await scanStepPlugins(stepPluginsDir));
  const registry: LoadedStepPluginRegistry = {};
  for (const [type, plugin] of Object.entries(base)) {
    registry[type] = { ...plugin, workers: { ...plugin.workers } };
  }

  if (!overrides) return registry;
  for (const [type, workers] of Object.entries(overrides)) {
    const plugin = registry[type];
    if (!plugin) {
      throw new Error(
        `workerOverrides: unknown step type "${type}" — an override replaces a scanned (type, worker) pair only, never adds one`,
      );
    }
    for (const [name, descriptor] of Object.entries(workers)) {
      if (!(name in plugin.workers)) {
        throw new Error(
          `workerOverrides: step type "${type}" ships no worker "${name}" to replace — an override is replace-only`,
        );
      }
      plugin.workers[name] = descriptor;
    }
  }
  return registry;
}

/**
 * The two run-start facts the analysis yields: the masking sink, and the failure that ends the run before its first
 * node (if any).
 */
export interface RunStartAnalysis {
  /** The `$secret` masking sink built from the run's whole resolved config; it escapes the analysis
   * because it lives past run start, and its `warnings` are the caller's to surface. */
  masker: SecretMasker;
  /** The run-start gate's verdict: `undefined` to proceed, else the message the run ends `failed` on
   * before its first node. An unset `$env` pre-empts the config-fragment check. */
  runStartFailure?: string;
}

/** The run's whole read of its config tree at start, in a fixed order that is the point: collect every
 * config unmerged, resolve `$env` before collecting `$secret` (masking is by value, so a wrapped `$env`
 * must carry its real value first), then validate each leaf's resolved config — but only if no `$env`
 * was unset, which pre-empts that check. */
export function analyzeRunStart(
  file: WorkflowFile,
  fileDir: string,
  options: RunOptions,
  env: EnvSource,
  registry: LoadedStepPluginRegistry,
): RunStartAnalysis {
  const configs = collectRunConfigs(file, options);
  const { configs: resolvedConfigs, unset } = resolveRunEnv(configs, env);
  const masker = collectSecrets(resolvedConfigs);
  const runStartFailure =
    unset.length > 0
      ? describeUnsetEnv(unset)
      : (options.unresolvedLaunchSecrets?.length ?? 0) > 0
        ? describeMissingLaunchSecrets(options.unresolvedLaunchSecrets as string[])
        : validateRunStartConfig(
            file,
            fileDir,
            options.files,
            options.operatorConfig ?? {},
            env,
            registry,
          );
  return { masker, runStartFailure };
}

/** Validates every leaf step's effective, resolved config against its type's fragment, aggregated into
 * one failure. Config is checked after `$env`/`$secret` resolution, and the fragment is passthrough
 * because an effective config legitimately carries keys a sibling leaf declared. */
function validateRunStartConfig(
  rootFile: WorkflowFile,
  rootDir: string,
  files: Map<string, WorkflowFile> | undefined,
  operatorConfig: ConfigObject,
  env: EnvSource,
  registry: LoadedStepPluginRegistry,
): string | undefined {
  const issues: string[] = [];

  // One descent of the loaded ref tree, so this gate reads the very `stepConfig` the executor
  // materializes; a file reached under two parents is validated once per incoming config.
  for (const { node, stepConfig } of walkRefTree(rootFile, rootDir, {
    files,
    operatorConfig,
    env,
  })) {
    if (node.type === "workflow") continue; // never a registry leaf; the walk descends it
    const plugin = registry[node.type];
    if (!plugin) continue;
    const result = z.object(plugin.config).passthrough().safeParse(stepConfig);
    if (!result.success) {
      for (const issue of formatIssues(result.error)) {
        issues.push(`step "${node.name}" (type ${node.type}): ${issue}`);
      }
    }
  }

  if (issues.length === 0) return undefined;
  return `run failed before its first step: ${
    issues.length === 1 ? "config validation failed" : `${issues.length} config validation errors`
  }: ${issues.join("; ")}`;
}

/** Every config object a run can read, in one sweep: operator overrides first (nearest config wins a
 * token key), then each reachable file's and step's config. Whole-tree deliberately: a shadowed
 * `{"$env": ...}` declaration must still be set, so failing at step 1 beats dying at step 14. Walks the
 * schema's `walkNodes`, not `file.body`, because a step's config can sit under any nesting. */
function collectRunConfigs(rootFile: WorkflowFile, options: RunOptions): ConfigObject[] {
  const configs: ConfigObject[] = [];
  if (options.operatorConfig) configs.push(options.operatorConfig);

  const files = options.files ? [...options.files.values()] : [rootFile];
  if (!files.includes(rootFile)) files.push(rootFile);
  for (const file of files) {
    if (file.config) configs.push(file.config);
    for (const node of walkNodes(file.body)) {
      if ("config" in node && node.config) configs.push(node.config);
    }
  }
  return configs;
}
