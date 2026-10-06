import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/** The status file `load-anchor.sh` writes once the anchor is loaded, as of boot `bootSec`. */
export function egressStatus(bootSec: number): string {
  return [
    `boottime=${bootSec}`,
    "Status: Enabled for 0 days 00:01:00           Debug: Urgent",
    "pass quick inet proto udp from 192.168.100.0/24 to 192.168.100.1 port = 53",
    "block drop quick inet from 192.168.100.0/24 to <path_blocked>",
    "block drop quick inet proto tcp from 192.168.100.0/24 to any port = 25",
    "block drop quick inet6 from fd1b:ba4d:5caa:caf8::/64 to any",
    "",
  ].join("\n");
}

let statusFile: string | undefined;

/** Points the next hosted `startPathServer` at a status file for this boot. */
export function stubEgressAnchor(): void {
  if (statusFile === undefined) {
    statusFile = join(mkdtempSync(join(tmpdir(), "path-egress-status-")), "status");
    writeFileSync(statusFile, egressStatus(Math.round(Date.now() / 1000 - uptime())));
  }
  vi.stubEnv("PATH_EGRESS_STATUS", statusFile);
}
