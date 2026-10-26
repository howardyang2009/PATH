import type { Message } from "@path/i18n";
import { useMessage } from "@path/i18n/react";
import { useTranslations } from "use-intl";

/** What a pane note says is being read. */
export type PaneSubject = "workflows" | "runs" | "run" | "input" | "output" | "context" | "secrets";

/** The shared loading/failure notes for the thing `what` names. */
export function PaneLoading({ what }: { what: PaneSubject }) {
  const t = useTranslations("shared.paneNote");
  return <p className="pane-note">{t(`loading.${what}`)}</p>;
}

export function PaneError({ what, message }: { what: PaneSubject; message: Message }) {
  const t = useTranslations("shared.paneNote");
  const renderMessage = useMessage();
  return (
    <p className="pane-note pane-error" role="alert">
      {t(`failed.${what}`, { message: renderMessage(message) })}
    </p>
  );
}
