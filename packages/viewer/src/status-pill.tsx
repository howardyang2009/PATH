import type { RunStatus } from "@path/client-core";
import { STATUS_GLYPH } from "./status-glyph.js";

/**
 * A run's status as a glyph + label pill. The `data-status` attribute selects the `--status-*`
 * token pair in `viewer.css` — colors are never picked here (#44 decision), and the label always
 * accompanies the color so the status survives without hue.
 */
export function StatusPill({ status, testId }: { status: RunStatus; testId?: string }) {
  return (
    <span className="pill" data-status={status} data-testid={testId}>
      <span className="pill-glyph" aria-hidden="true">
        {STATUS_GLYPH[status]}
      </span>
      {status}
    </span>
  );
}
