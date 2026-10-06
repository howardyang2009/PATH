import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPathServer } from "../src/create-server.js";
import { assertEgressAnchor, egressAnchorProblem } from "../src/sandbox/egress-anchor.js";
import { stubHostedEnv } from "./fixtures/clerk-token.js";
import { egressStatus } from "./fixtures/egress-status.js";

const BOOT = 1_759_650_000;

describe("egressAnchorProblem", () => {
  it("accepts a status written this boot with pf on and the anchor's rules", () => {
    expect(egressAnchorProblem(egressStatus(BOOT), BOOT)).toBeUndefined();
  });

  it("accepts a boot time a few seconds off, as the clock reads it", () => {
    expect(egressAnchorProblem(egressStatus(BOOT), BOOT + 2)).toBeUndefined();
  });

  it("names the anchor when the status file is missing", () => {
    expect(egressAnchorProblem(undefined, BOOT)).toMatch(/pf anchor `path` is not loaded/);
  });

  it("refuses a status from an earlier boot", () => {
    expect(egressAnchorProblem(egressStatus(BOOT - 3600), BOOT)).toMatch(/earlier boot/);
  });

  it("refuses when pf is disabled", () => {
    const status = egressStatus(BOOT).replace("Status: Enabled", "Status: Disabled");
    expect(egressAnchorProblem(status, BOOT)).toMatch(/pf is not enabled/);
  });

  it("refuses an anchor without its block rules", () => {
    const status = `boottime=${BOOT}\nStatus: Enabled for 0 days 00:01:00\n`;
    expect(egressAnchorProblem(status, BOOT)).toMatch(/anchor `path` has no block rules/);
  });
});

describe("hosted boot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "path-egress-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the status file `PATH_EGRESS_STATUS` names", () => {
    const file = join(dir, "status");
    writeFileSync(file, "Status: Disabled\n");
    expect(() => assertEgressAnchor({ PATH_EGRESS_STATUS: file })).toThrow(
      /pf anchor `path`.*Refusing to start/s,
    );
  });

  it("refuses to start without the anchor and names it", async () => {
    stubHostedEnv();
    vi.stubEnv("PATH_EGRESS_STATUS", join(dir, "missing"));
    await expect(startPathServer(dir)).rejects.toThrow(/pf anchor `path` is not loaded/);
  });

  it("starts with the anchor loaded", async () => {
    stubHostedEnv();
    const handle = await startPathServer(dir);
    await handle.close();
  });
});
