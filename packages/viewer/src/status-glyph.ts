import type { RunStatus } from "@path/client-core";

/**
 * Run status is rendered as **color + glyph, never hue alone** (accessibility, per `dataviz`); the
 * glyphs are the set pinned by the #44 decision comment, and the colors are the `--status-*` token
 * pairs in `tokens.css`. Keyed by `RunStatus`, so a new status is a type error here rather than a
 * silently blank pill.
 *
 * Key order is the display order of the status filter: `running` first — the status a monitor is
 * opened to watch — then the terminal outcomes by how much they demand attention, then `pending`.
 */
export const STATUS_GLYPH: Record<RunStatus, string> = {
  running: "◐",
  succeeded: "✓",
  failed: "✕",
  cancelled: "⊘",
  pending: "◌",
};

/**
 * The statuses in display order — derived from the glyph map, so the two cannot drift. Distinct
 * from `@path/engine`'s `RUN_STATUSES` (persistence order) and deliberately not imported from it:
 * that is a Node package, and this ordering is a view concern.
 */
export const ORDERED_RUN_STATUSES = Object.keys(STATUS_GLYPH) as RunStatus[];
