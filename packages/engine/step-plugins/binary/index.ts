import { spawn } from "node:child_process";

import { defineStepPlugin, resolveAgainstWorkflowDir, z } from "@path/engine/plugin";
import type { StepRequest, StepResult } from "@path/engine/plugin";

/**
 * PATH's built-in `binary` leaf step type, shipped as a plugin folder under `step-plugins/` and
 * written against the public `@path/engine/plugin` subpath exactly as a third-party plugin is (ADR
 * 0019 sub-10, #336). It is the load-bearing dogfood of that surface: if the subpath cannot express
 * this worker, the gap surfaces here at author time, not in a third party's tree.
 *
 * The folder name *is* the type name, so this file states none. Since the cutover (#337) this folder
 * is the *only* `binary` implementation — the old `src/binary-worker.ts` is gone, and the engine
 * dispatches every `binary` step through the worker discovered here.
 */

// The `binary` type's author-fixed node fields (ADR 0022 sub-1): a command line and an optional
// working directory. `.strict()` and the interpolation the engine applies before the worker runs are
// the schema factory's job — the plugin declares only the shapes.
const fields = {
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
};

// `binary` needs no injected config keys, so its `config` fragment is empty. It stays uncapped and
// meters nothing — a child process is not a metered processor slot.
const config = {};

/**
 * The `spawn` worker: one child process per step-run, torn down when the call settles. It resolves its
 * own `cwd` field against `request.cwd` via `resolveAgainstWorkflowDir` — the workflow file's
 * directory, never `process.cwd()` (#313 sub-14). An omitted `cwd` resolves to `request.cwd` itself.
 *
 * Its errors name no step: the engine owns the node's name and prefixes it when it surfaces the result
 * (ADR 0021 sub-6). The engine also owns `cancelled`, deriving it from `request.signal.aborted`, so an
 * abort here just settles the promise and the child is killed; the reported status does not matter.
 */
function runSpawn(request: StepRequest<typeof fields, typeof config>): Promise<StepResult> {
  const { command, cwd } = request.fields;
  const args = request.fields.args ?? [];
  const resolvedCwd = resolveAgainstWorkflowDir(request.cwd, cwd ?? "");
  const { input, signal } = request;

  return new Promise((resolveResult) => {
    if (signal.aborted) {
      resolveResult({ status: "failed", error: "cancelled", stderr: "" });
      return;
    }

    const child = spawn(command, args, { cwd: resolvedCwd });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });

    const settle = (result: StepResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolveResult(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      // An abort surfaces here as a spawn/kill error; the engine relabels it cancelled from the signal.
      if (signal.aborted) {
        settle({ status: "failed", error: "cancelled", stderr });
        return;
      }
      settle({ status: "failed", error: `failed to start "${command}": ${err.message}`, stderr });
    });
    child.on("close", (code) => {
      // A kill from `signal` closes the child with a null exit code — a cancellation, not a step
      // failure, and the engine derives that from the signal rather than this status.
      if (signal.aborted) {
        settle({ status: "failed", error: "cancelled", stderr });
        return;
      }
      if (code !== 0) {
        // The message keeps only the tail; the audit blob keeps the whole stderr (format doc §4.2).
        const tail = stderr.trim().slice(-500);
        settle({ status: "failed", error: `exited with code ${code}${tail ? `: ${tail}` : ""}`, stderr });
        return;
      }
      settle({ status: "succeeded", output: stdout, stderr });
    });

    // Input is offered on stdin, not required (format doc §4.2): a child that exits without reading it
    // EPIPEs our write. Swallow stdin errors — the outcome is decided by the exit code in "close".
    child.stdin.on("error", () => {});
    child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
    child.stdin.end();
  });
}

export const stepPlugin = defineStepPlugin({
  fields,
  config,
  workers: {
    spawn: { meters: false, needsProcessorSlot: false, run: runSpawn },
  },
  defaultWorker: "spawn",
});
