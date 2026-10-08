import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVmUsage } from "../src/vm-usage.js";

/** VM time per user (docs/spec/path-website.md §8): a host-level table of each VM's start and end,
 * summed over a rolling 24 h. */

const HOUR = 60 * 60 * 1000;

let dir: string;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-vm-usage-test-"));
  clock = Date.UTC(2026, 9, 8, 12);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("openVmUsage", () => {
  it("sums each user's VM time, a running VM counting up to now", () => {
    const usage = openVmUsage(":memory:", now);
    const end = usage.begin("alice");
    clock += HOUR;
    end();
    end();
    usage.begin("alice");
    clock += HOUR / 2;

    expect(usage.usedMs("alice")).toBe(1.5 * HOUR);
    expect(usage.usedMs("bob")).toBe(0);
    usage.close();
  });

  it("counts only the last 24 h", () => {
    const usage = openVmUsage(":memory:", now);
    const end = usage.begin("alice");
    clock += 2 * HOUR;
    end();
    clock += 23 * HOUR;

    expect(usage.usedMs("alice")).toBe(HOUR);
    usage.close();
  });

  it("names when the budget frees enough to launch again", () => {
    const usage = openVmUsage(":memory:", now);
    const started = clock;
    const end = usage.begin("alice");
    clock += 2 * HOUR;
    end();

    expect(usage.retryAt("alice", 3 * HOUR)).toBeUndefined();
    // Usage drops under 2 h once the window slides past the VM's first second.
    const retryAt = usage.retryAt("alice", 2 * HOUR) ?? 0;
    expect(retryAt).toBeGreaterThan(started + 24 * HOUR);
    expect(retryAt).toBeLessThanOrEqual(started + 24 * HOUR + 1000);
    expect(usage.retryAt("alice", 0)).toBe(Number.POSITIVE_INFINITY);
    usage.close();
  });

  it("keeps usage across a restart and ends the VMs a previous process left open", () => {
    const path = join(dir, "host.db");
    const first = openVmUsage(path, now);
    first.begin("alice");
    clock += HOUR / 2;
    first.close();

    clock += HOUR / 4;
    const second = openVmUsage(path, now);
    clock += HOUR;
    expect(second.usedMs("alice")).toBe(0.75 * HOUR);
    second.close();
  });

  it("charges a VM left open across a long outage at most its time limit", () => {
    const path = join(dir, "host.db");
    const first = openVmUsage(path, now);
    first.begin("alice");
    first.close();

    clock += 5 * HOUR;
    const second = openVmUsage(path, now);
    expect(second.usedMs("alice")).toBe(HOUR);
    second.close();
  });
});
