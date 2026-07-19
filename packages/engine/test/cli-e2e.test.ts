import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(packageRoot, "test", "fixtures");
const bin = join(packageRoot, "bin", "path.ts");

function runCli(args: string[]) {
  return execFileAsync("npx", ["tsx", bin, ...args], { cwd: packageRoot });
}

describe("path run (real dev-mode process, no packaging)", () => {
  it("runs a two-binary-step workflow end to end via tsx", async () => {
    const { stdout } = await runCli(["run", join(fixtures, "two-binary-steps.workflow.json")]);
    expect(stdout.trim()).toBe("HELLO");
  });

  it("exits non-zero with load errors surfaced, running nothing", async () => {
    await expect(runCli(["run", join(fixtures, "invalid-schema.workflow.json")])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("bogus_field"),
    });
  });

  it("exits non-zero when a step fails, and does not run subsequent steps", async () => {
    await expect(runCli(["run", join(fixtures, "failing-step.workflow.json")])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("boom"),
    });
  });
});
