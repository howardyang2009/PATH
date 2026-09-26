import { type ConfigObject, formatIssues, type WorkflowFile, walkNodes } from "@path/schema";
import { z } from "zod";
import { describeMissingLaunchSecrets } from "./launch-facts.js";
import { type LoadedStepPluginRegistry, scanStepPlugins } from "./plugin/scan.js";
import { walkRefTree } from "./ref-tree.js";
import { describeUnsetEnv, type EnvSource, resolveRunEnv } from "./resolve-env.js";
import type { RunOptions, WorkerOverrides } from "./run-workflow.js";
import { collectSecrets, type SecretMasker } from "./secret-mask.js";

/**
 * **Run start**: everything a root run settles before its first node — the frozen executor registry
 * it dispatches against, and one read of the whole config tree that yields the secret masker and the
 * run-start gate's verdict. `runWorkflow` calls the two entry points here and nothing below them.
 */

/**
 * The frozen executor registry for one run, with `workerOverrides` merged over it **replace-only**
 * (ADR 0021 sub-15).
 *
 * The base registry is the load's own (`provided`, `LoadedWorkflow.registry`) when the caller ran a
 * load — so the run dispatches against exactly the registry the schema validated the file against,
 * with no second scan of the folder. A caller with no load (a test, an embedder) passes none, and the
 * folder is scanned here as the fallback, hitting Node's ESM cache for an unchanged folder. `stepPluginsDir`
 * points that fallback scan elsewhere; it is unread when `provided` is set (see `RunOptions.stepPluginsDir`).
 *
 * Either way each plugin and its `workers` map is shallow-cloned before an override is applied, so a
 * replacement never mutates the load's frozen registry or the cached module object a later scan would
 * read again. An override naming a `(type, name)` pair the base did not produce is a hard error, never
 * an insertion — the registry's name set stays owned by the folder scan (ADR 0019 sub-2).
 */
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

/** The two run-start facts the analysis yields: the masking sink, and the failure that ends the run before its first node (if any). */
export interface RunStartAnalysis {
  /**
   * The `$secret` masking sink built from the run's whole resolved config (mvp spec §8.3, #20). It
   * escapes the analysis because it lives past run start: it is the emit choke point's masker and the
   * one that scrubs what a finished run returns. Its `warnings` are the caller's to surface.
   */
  masker: SecretMasker;
  /**
   * The run-start gate's verdict (#116, ADR 0022 sub-3): `undefined` to proceed, else the message the
   * run ends `failed` on before its first node. Names unset `$env` variables, or config-fragment
   * mismatches — never both, because the first pre-empts the second (see below).
   */
  runStartFailure?: string;
}

/**
 * The run's whole read of its config tree at start, in one place (#116, #20, ADR 0022 sub-3). It exists
 * so `runWorkflow` reads run-start as a single fact rather than four scattered statements, and so the
 * gate's staging — which is load-bearing — has one owner and one test surface.
 *
 * **Four passes, in a fixed order, and why they are not one.** The order is the point, not an accident:
 *
 * 1. **Collect** every config object across the whole tree, unmerged (`collectRunConfigs`) — whole-tree
 *    because a `$env` a parent's config shadows must still be set, and a `$secret` anywhere must still be
 *    masked (its comment carries the reasoning).
 * 2. **Resolve `$env`** over that set (`resolveRunEnv`), *before* collecting secrets: masking is by value
 *    (§8.3), so `{"$secret": {"$env": "TOKEN"}}` must already carry the real value or the masker collects
 *    the literal `TOKEN` and the credential reaches disk unmasked. Unset variables surface here.
 * 3. **Collect `$secret`** from the resolved set into the masker (`collectSecrets`).
 * 4. **Validate** each leaf's effective, merged, resolved config against its type's fragment
 *    (`validateRunStartConfig`) — but *only if* no `$env` was unset: config cannot be validated against
 *    values it could not resolve, so an unset variable pre-empts the fragment check.
 *
 * Passes 1 and 4 both walk the tree, but compute different things — 1 flattens raw config pre-resolution,
 * 4 merges effective config per leaf post-resolution — and 4 is gated on 2's result. Folding them into
 * one traversal would entangle collection with validation and lose the "resolve every `$env` first, then
 * validate" staging, so they stay distinct passes behind this one door rather than one merged walk.
 */
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

/**
 * The run-start config validation (ADR 0022 sub-3): walk the whole ref tree the way the run will,
 * threading effective config across each `workflow` boundary exactly as `runWorkflowNode` does, and
 * validate every leaf step's effective, resolved config against its type's `config` fragment. One
 * aggregated failure names every missing or mismatched key across the whole tree — this is where
 * `prompt`'s required `model` is now caught (ADR 0021 sub-10 → ADR 0022 sub-5), before the first step.
 *
 * Config is validated **after** resolution (sub-decision 4): `$env` at the effective-config merge and
 * `$secret` unwrapped, so a fragment's `z.string()` checks the literal a wrapper resolved to. The
 * fragment is `.passthrough()` — effective config legitimately carries keys a sibling leaf declared.
 */
function validateRunStartConfig(
  rootFile: WorkflowFile,
  rootDir: string,
  files: Map<string, WorkflowFile> | undefined,
  operatorConfig: ConfigObject,
  env: EnvSource,
  registry: LoadedStepPluginRegistry,
): string | undefined {
  const issues: string[] = [];

  // One descent of the loaded ref tree (`walkRefTree`), so this gate reads the very `stepConfig` the
  // executor materializes. A file reached under two parents is validated once per incoming config, each
  // against what actually reaches it (format §8) — the walk carries that, not this fold.
  for (const { node, stepConfig } of walkRefTree(rootFile, rootDir, {
    files,
    operatorConfig,
    env,
  })) {
    if (node.type === "workflow") continue; // grammar-fixed, never a registry leaf; the walk descends it
    const plugin = registry[node.type];
    if (!plugin) continue; // the schema already rejects a type no registry contributes
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

/**
 * Every config object a run can read, in one sweep: operator overrides first (they win a token key
 * on a duplicated value — nearest config), then each reachable file's declared config and each of
 * its steps' configs, since a value rides inheritance to any of them.
 *
 * Two run-start readings share it: masking collects `$secret` values from all of them (#20), and
 * `$env` resolution checks all of them (#116).
 *
 * **Whole-tree, and deliberately so for `$env`.** A file in the loaded tree declaring `{"$env":
 * "OPENAI_KEY"}` forces the variable to be set *even when a parent's config shadows that key* and
 * the declaration can therefore never be read. Harmless for masking; for failing a run it is a real
 * cost, accepted because the alternative — resolving per file as the run reaches it — is a run that
 * starts and dies at step 14 for a variable already missing at step 1. `test/run-workflow.test.ts`
 * pins it so it stays a decision.
 *
 * The descent is @path/schema's (`walkNodes`), not `file.body`: a step's config can sit inside any
 * nesting of control blocks, and a hand-rolled top-level loop silently skipped every one of them —
 * an unmasked secret, and a wrapper handed to a worker in place of a credential.
 */
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
