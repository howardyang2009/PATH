import type { RunStatus } from "@path/client-core";

/** Run status is colour + glyph, never hue alone; keyed by `RunStatus`, so a new status is a type error here. */
export const RUN_STATUS_GLYPH: Record<RunStatus, string> = {
  running: "◐",
  awaiting: "◔",
  succeeded: "✓",
  failed: "✕",
  cancelled: "⊘",
  pending: "◌",
};
