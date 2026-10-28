import { type RunStatus, runStatusReading } from "@path/client-core";
import { useMessage } from "@path/i18n/react";

/** `data-status` selects the `--status-*` token pair in `viewer.css`; the label always carries the
 * status too, so it survives without hue. */
export function StatusPill({ status }: { status: RunStatus }) {
  const renderMessage = useMessage();
  const reading = runStatusReading(status);
  return (
    <span className="pill" data-status={status}>
      <span className="pill-glyph" aria-hidden="true">
        {reading.glyph}
      </span>
      {renderMessage(reading.message)}
    </span>
  );
}
