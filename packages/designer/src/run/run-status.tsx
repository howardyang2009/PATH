import type { RunStatus } from "@path/client-core";

/**
 * Run status is rendered as **colour + glyph, never hue alone** (accessibility). The Designer authors
 * its own glyph/pill look (ADR 0025: status glyph and pill styling stay view, and the two surfaces are
 * meant to look different). Keyed by `RunStatus`, so a new status is a type error here, not a blank pill.
 *
 * Key order is the display order of the status filter: `running` first — what an author watches a test
 * run for — then the terminal outcomes by how much they demand attention, then `pending`.
 */
export const RUN_STATUS_GLYPH: Record<RunStatus, string> = {
  running: "◐",
  succeeded: "✓",
  failed: "✕",
  cancelled: "⊘",
  pending: "◌",
};

/** The statuses in display order — derived from the glyph map, so the two cannot drift. */
export const ORDERED_RUN_STATUSES = Object.keys(RUN_STATUS_GLYPH) as RunStatus[];

/**
 * A run's status as a glyph + label pill. The `data-status` attribute selects the `--run-status-*` token
 * pair in the Designer's stylesheet — colours are never picked here, and the label always accompanies
 * the colour so the status survives without hue.
 */
export function RunStatusPill({ status }: { status: RunStatus }): JSX.Element {
  return (
    <span className="run-pill" data-status={status}>
      <span className="run-pill-glyph" aria-hidden="true">
        {RUN_STATUS_GLYPH[status]}
      </span>
      {status}
    </span>
  );
}
