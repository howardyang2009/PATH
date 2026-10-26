import type { RunStatus } from "@path/client-core";
import { useTranslations } from "use-intl";
import { STATUS_GLYPH } from "./status-glyph.js";

/** `data-status` selects the `--status-*` token pair in `viewer.css`; the label always carries the
 * status too, so it survives without hue. */
export function StatusPill({ status }: { status: RunStatus }) {
  const t = useTranslations("shared.status");
  return (
    <span className="pill" data-status={status}>
      <span className="pill-glyph" aria-hidden="true">
        {STATUS_GLYPH[status]}
      </span>
      {t(status)}
    </span>
  );
}
