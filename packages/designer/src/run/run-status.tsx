import type { RunStatus } from "@path/client-core";

/**
 * Run status is rendered as **colour + glyph, never hue alone** (accessibility). The Designer authors
 * its own glyph look (ADR 0025: status glyph styling stays view, and the two surfaces are meant to look
 * different). Keyed by `RunStatus`, so a new status is a type error here, not a missing glyph.
 */
export const RUN_STATUS_GLYPH: Record<RunStatus, string> = {
  running: "◐",
  awaiting: "◔",
  succeeded: "✓",
  failed: "✕",
  cancelled: "⊘",
  pending: "◌",
};
