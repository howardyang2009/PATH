import type { DiscoveryLoad } from "./discovery.js";
import { discoveredWorkflows } from "./discovery.js";

/** Why the Server will refuse a write to an open document (ADR 0088): a shipped file is never
 * written, and a shared one only by the user who created it. */
export type ReadOnlyReason = "shipped" | "shared";

/** The hint a disabled Save or Delete shows. */
export const READ_ONLY_TITLE: Record<ReadOnlyReason, string> = {
  shipped: "Read-only: shipped",
  shared: "Read-only: shared by another user",
};

/** The reason the workflow at `path` is read-only, from its discovery row; `false` while it is
 * writable or not yet discovered. */
export function workflowReadOnly(
  discovery: DiscoveryLoad,
  path: string | undefined,
): ReadOnlyReason | false {
  const row = discoveredWorkflows(discovery)?.find((w) => w.relative_path === path);
  if (!row?.read_only) return false;
  return row.origin === "shipped" ? "shipped" : "shared";
}
