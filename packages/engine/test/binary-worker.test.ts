import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runBinaryStep, type ResolvedBinaryStep } from "../src/binary-worker.js";

/** A step running the given inline node script — the engine's own executable, on every machine. */
function nodeStep(script: string, name = "step-1"): ResolvedBinaryStep {
  return { name, command: process.execPath, args: ["-e", script], cwd: tmpdir() };
}

/** Reads all of stdin and writes it back out, so a test can assert what the child was handed. */
const ECHO_STDIN = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))";

describe("runBinaryStep", () => {
  it("captures stdout as the output of a zero exit", async () => {
    const result = await runBinaryStep(nodeStep("process.stdout.write('hello')"), {});

    expect(result).toEqual({ status: "succeeded", output: "hello", stderr: "" });
  });

  it("reports stderr on success too — it is captured for audit, not only for failures", async () => {
    const result = await runBinaryStep(nodeStep("process.stderr.write('a warning');process.stdout.write('ok')"), {});

    expect(result).toEqual({ status: "succeeded", output: "ok", stderr: "a warning" });
  });

  it("fails a non-zero exit with the step id, the code and the stderr tail", async () => {
    const result = await runBinaryStep(
      nodeStep("process.stderr.write('bad things happened');process.exit(3)", "boom"),
      {},
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ error: 'step "boom" exited with code 3: bad things happened' });
    expect(result.stderr).toBe("bad things happened");
  });

  it("keeps only the last 500 characters of stderr in the error", async () => {
    const result = await runBinaryStep(nodeStep("process.stderr.write('x'.repeat(600));process.exit(1)"), {});

    expect(result).toMatchObject({ status: "failed", error: `step "step-1" exited with code 1: ${"x".repeat(500)}` });
    // The blob keeps the whole thing; only the message is trimmed.
    expect(result.stderr).toHaveLength(600);
  });

  it("fails a command that cannot start, naming the command", async () => {
    const step: ResolvedBinaryStep = {
      name: "missing",
      command: "path-no-such-binary-8f3a",
      args: [],
      cwd: tmpdir(),
    };

    const result = await runBinaryStep(step, {});

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      error: expect.stringContaining('step "missing" failed to start "path-no-such-binary-8f3a"'),
    });
  });

  it("settles cancelled when the signal aborts mid-run — a kill is not a non-zero exit", async () => {
    const controller = new AbortController();
    const running = runBinaryStep(nodeStep("setTimeout(()=>{},5000)"), {}, controller.signal);
    setTimeout(() => controller.abort(), 50);

    const result = await running;

    // A SIGTERM closes the child with a null exit code; reporting that as `failed` would land the
    // cancellation as a workflow failure (mvp spec §5.6).
    expect(result.status).toBe("cancelled");
  });

  it("settles cancelled without spawning when the signal is already aborted", async () => {
    const step: ResolvedBinaryStep = {
      name: "never-runs",
      command: "path-no-such-binary-8f3a",
      args: [],
      cwd: tmpdir(),
    };

    const result = await runBinaryStep(step, {}, AbortSignal.abort());

    // A spawn attempt would have reported `failed to start` instead.
    expect(result).toEqual({ status: "cancelled", stderr: "" });
  });

  it("survives a child that exits without reading stdin", async () => {
    // Input far larger than a pipe buffer, so the write cannot complete before the child is gone.
    const result = await runBinaryStep(nodeStep("process.exit(0)"), "x".repeat(1_000_000));

    expect(result).toEqual({ status: "succeeded", output: "", stderr: "" });
  });

  it("offers a string input on stdin raw", async () => {
    const result = await runBinaryStep(nodeStep(ECHO_STDIN), "just text");

    expect(result).toMatchObject({ status: "succeeded", output: "just text" });
  });

  it("offers a non-string input on stdin as its JSON serialization", async () => {
    const result = await runBinaryStep(nodeStep(ECHO_STDIN), { name: "ada", n: 2 });

    expect(result).toMatchObject({ status: "succeeded", output: '{"name":"ada","n":2}' });
  });
});
