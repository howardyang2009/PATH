import { DEFAULT_SHIPPED_TEMPLATE_DIR } from "../template-store.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * The shipped template root the union scans: the ctx override (a test's fixture root) or the
 * package-relative default (`packages/server/template`). One place, so the five template routes cannot
 * disagree about where shipped templates live.
 */
export function shippedTemplateDir(ctx: RunsRouteContext): string {
  return ctx.shippedTemplateDir ?? DEFAULT_SHIPPED_TEMPLATE_DIR;
}
