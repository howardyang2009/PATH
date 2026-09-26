import type { RunStatus } from "@path/client-core";

/** Color + glyph, never hue alone; colors are `tokens.css`'s `--status-*` pairs. */
export const STATUS_GLYPH: Record<RunStatus, string> = {
  running: "◐",
  awaiting: "⏳",
  succeeded: "✓",
  failed: "✕",
  cancelled: "⊘",
  pending: "◌",
};

/** Display order; not `@path/engine`'s `RUN_STATUSES`, whose order is persistence, not view. */
export const ORDERED_RUN_STATUSES = Object.keys(STATUS_GLYPH) as RunStatus[];
