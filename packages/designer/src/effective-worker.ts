import type { WireStepPlugin } from "@path/client-core";
import { type WorkflowFile, type WorkflowNode, walkNodes } from "@path/schema";
import { pluginFor } from "./editor-tiers.js";
import { nodeString } from "./node-edit.js";

/** The worker the step runs on in the Designer's view: pinned, else the file default, else the
 * type's own. The launch tier lives in no file, so it is not seen here. */
export function effectiveWorker(
  file: WorkflowFile,
  node: WorkflowNode,
  plugins: readonly WireStepPlugin[],
): string | undefined {
  return (
    nodeString(node, "worker") ||
    file.worker_defaults?.[node.type] ||
    pluginFor(node.type, [...plugins])?.default_worker
  );
}

/** Every worker the file's own steps run on, without following a workflow reference. */
export function fileWorkers(file: WorkflowFile, plugins: readonly WireStepPlugin[]): string[] {
  const workers = new Set<string>();
  for (const node of walkNodes(file.body)) {
    const worker = effectiveWorker(file, node, plugins);
    if (worker !== undefined) workers.add(worker);
  }
  return [...workers];
}
