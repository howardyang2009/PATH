import { readFileSync } from "node:fs";
import { uptime } from "node:os";

/**
 * The hosted-mode check that `pf` anchor `path` filters run VM egress (docs/spec/path-website.md
 * §10). Only root can query `pf`, so the boot daemon (`sandbox/egress/load-anchor.sh`) writes this
 * status file once the anchor is loaded, and the Server reads it.
 */
export const EGRESS_STATUS_FILE = "/var/run/path-egress.status";

/** How far the status file's boot time may drift from the one the clock gives. */
const BOOT_SLACK_SEC = 60;

const INSTALL_HINT = "install it with packages/server/sandbox/egress/install.sh";

/** Why `status` does not prove the anchor is loaded this boot, or `undefined` when it does. */
export function egressAnchorProblem(
  status: string | undefined,
  bootSec: number,
): string | undefined {
  if (status === undefined) {
    return `pf anchor \`path\` is not loaded: no status file; ${INSTALL_HINT}`;
  }
  const written = Number(/^boottime=(\d+)$/m.exec(status)?.[1]);
  if (!(Math.abs(written - bootSec) <= BOOT_SLACK_SEC)) {
    return "pf anchor `path`: the status file is from an earlier boot; the boot daemon did not run";
  }
  if (!/^Status: Enabled/m.test(status)) return "pf anchor `path`: pf is not enabled";
  if (!status.includes("<path_blocked>") || !/^block drop quick inet6 /m.test(status)) {
    return `pf anchor \`path\` has no block rules; ${INSTALL_HINT}`;
  }
  return undefined;
}

/** Why the anchor is not loaded, or `undefined` when it is; `PATH_EGRESS_STATUS` names another
 * status file. */
export function egressAnchorFailure(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let status: string | undefined;
  try {
    status = readFileSync(env.PATH_EGRESS_STATUS || EGRESS_STATUS_FILE, "utf8");
  } catch {
    status = undefined;
  }
  return egressAnchorProblem(status, Date.now() / 1000 - uptime());
}
