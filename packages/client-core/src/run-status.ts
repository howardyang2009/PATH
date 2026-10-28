import type { Message } from "@path/i18n";
import type { RunStatus } from "@path/schema";

/** The statuses in the order a surface lists them — not `@path/engine`'s `RUN_STATUSES`, whose
 * order is persistence, not view. `pending` is listed last: a stored run is never pending. */
export const RUN_STATUS_ORDER: readonly RunStatus[] = [
  "running",
  "awaiting",
  "succeeded",
  "failed",
  "cancelled",
  "pending",
];

/** Colour + glyph, never hue alone; the colour comes from `tokens.css`'s `--status-*` pairs. */
const RUN_STATUS_GLYPH: Record<RunStatus, string> = {
  running: "◐",
  awaiting: "⏳",
  succeeded: "✓",
  failed: "✕",
  cancelled: "⊘",
  pending: "◌",
};

/** What one status reads as: its catalogue label, and the glyph beside it. */
export interface RunStatusReading {
  message: Message;
  glyph: string;
}

/** The one reading of a run status: the Viewer's pill, the narrative row and the Designer's canvas
 * badges all draw this, so a fifth status is one catalogue key and one glyph, not two maps. */
export function runStatusReading(status: RunStatus): RunStatusReading {
  return { message: { key: `shared.status.${status}` }, glyph: RUN_STATUS_GLYPH[status] };
}
