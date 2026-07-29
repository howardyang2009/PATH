import { spawn } from "node:child_process";
import type { JsonValue } from "@path/schema";

/**
 * How the engine worker runs a `binary` step: one child process per step-run, torn down when the
 * call settles. The peer of `llm/agent-sdk-worker.ts` — that module is where a `prompt` step's
 * processor lives, this one is where a `binary` step's does (CONTEXT: *Processor*). Neither is the
 * run-tree walk, which is why this is not in `run-workflow.ts`.
 *
 * The two are deliberately *not* one interface: a prompt request carries a model, an instruction
 * and a worker-side options bag, a binary one carries a command line and a working directory, and
 * they share nothing but their cancellation. Two seams, one per worker type (format doc §7).
 */

// The same three outcomes every other terminal shape in the engine carries, spelled the same way.
// `stderr` rides all three because it is captured for audit regardless of how the child ended
// (format doc §4.2).
export type BinaryStepResult = { stderr: string } & (
  | { status: "succeeded"; output: string }
  | { status: "failed"; error: string }
  // The child was killed because a sibling parallel branch failed, or an operator cancelled (mvp
  // spec §5.6): not a genuine failure of this step, so it carries no error — its cause is narrated
  // by the run-cancelled event.
  | { status: "cancelled" }
);

// The step's `command`/`args`/`cwd` after interpolation — they travel together everywhere a
// binary step actually runs, so runBinaryStep takes this instead of three loose parameters.
export interface ResolvedBinaryStep {
  id: string;
  command: string;
  args: string[];
  cwd: string;
}

// I/O convention per format doc §4.2: input object on stdin (raw if a string, else its JSON
// serialization), captured stdout is the output, non-zero exit fails the step. stderr is always
// returned (even on success) so the caller can hand it to RunObserver.stepStderr for the audit
// blob (format doc §4.2: captured, secret-scrubbed later, never passed downstream).
//
// `signal` carries best-effort cancellation (mvp spec §5.6): a parallel branch runs its steps
// under the block's abort signal, and when a sibling fails the child process is killed — reported
// as `cancelled`, distinct from a genuine non-zero exit, so no publishes from it land.
export function runBinaryStep(
  step: ResolvedBinaryStep,
  input: JsonValue,
  signal?: AbortSignal,
): Promise<BinaryStepResult> {
  const { id: nodeId, command, args, cwd } = step;
  return new Promise((resolveResult) => {
    if (signal?.aborted) {
      resolveResult({ status: "cancelled", stderr: "" });
      return;
    }
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (result: BinaryStepResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (signal?.aborted) {
        settle({ status: "cancelled", stderr });
        return;
      }
      settle({ status: "failed", error: `step "${nodeId}" failed to start "${command}": ${err.message}`, stderr });
    });
    child.on("close", (code) => {
      // A kill from `signal` closes the process with a null exit code — that is a cancellation, not
      // a step failure, so it never lands as a non-zero-exit error.
      if (signal?.aborted) {
        settle({ status: "cancelled", stderr });
        return;
      }
      if (code !== 0) {
        const tail = stderr.trim().slice(-500);
        settle({
          status: "failed",
          error: `step "${nodeId}" exited with code ${code}${tail ? `: ${tail}` : ""}`,
          stderr,
        });
        return;
      }
      settle({ status: "succeeded", output: stdout, stderr });
    });

    // A child may exit without ever reading stdin (input is offered on stdin, not required —
    // format doc §4.2), which EPIPEs our write. Swallow stdin errors: the step's outcome is
    // decided by the exit code in "close", and a broken pipe must not crash the engine.
    child.stdin.on("error", () => {});
    child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
    child.stdin.end();
  });
}
