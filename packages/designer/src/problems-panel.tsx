import type { MessageKey } from "@path/i18n";
import { useMessage } from "@path/i18n/react";
import { useTranslations } from "use-intl";
import type { Problem, ProblemKind } from "./problems.js";
import { useSelection } from "./selection-context.js";

/**
 * The aggregate problems panel. The per-node ⚠ marker and this panel are **two coupled surfaces**:
 * a marker on a collapsed or off-screen node is invisible, so every current cross-node error is
 * also listed here, each row jumping to its node. These are **soft** errors — they do not block
 * save.
 */

/** The short tag each row wears, naming which check flagged it. */
const KIND_LABEL: Record<ProblemKind, MessageKey> = {
  "publish-conflict": "designer.problems.kind.publish",
  "dangling-interpolation": "designer.problems.kind.contextRead",
  "dangling-condition": "designer.problems.kind.condition",
  "dangling-ref": "designer.problems.kind.ref",
  "target-absent": "designer.problems.kind.goto",
  "target-inner": "designer.problems.kind.goto",
  "target-self": "designer.problems.kind.goto",
  placement: "designer.problems.kind.goto",
};

/** Select the node and scroll its block into view — the panel's jump-to-node. */
function jumpTo(nodeId: string, onSelect: (id: string) => void): void {
  onSelect(nodeId);
  const block = document.querySelector(`[data-node-id="${nodeId}"]`);
  // `scrollIntoView` is absent under jsdom; the select above is the load-bearing half a test
  // asserts.
  block?.scrollIntoView?.({ block: "center", behavior: "smooth" });
}

export function ProblemsPanel({ problems }: { problems: Problem[] }): JSX.Element | null {
  const t = useTranslations();
  const renderMessage = useMessage();
  const selection = useSelection();
  if (problems.length === 0) return null;

  const count = problems.length;
  const warnings = t("designer.problems.warnings", { count });
  return (
    <section className="problems-panel" aria-label={t("designer.problems.label")}>
      <header className="problems-head">
        <span className="problems-title" role="img" aria-label={warnings}>
          ⚠ {warnings}
        </span>
        <span className="problems-note">{t("designer.problems.note")}</span>
      </header>
      <ul className="problems-list">
        {problems.map((problem, index) => {
          const message = renderMessage(problem.message);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a node can repeat a kind, so the index disambiguates.
            <li className="problems-row" key={`${problem.nodeId}:${problem.kind}:${index}`}>
              <button
                type="button"
                className="problems-jump"
                data-testid={`problem-jump-${problem.nodeId}`}
                onClick={selection ? () => jumpTo(problem.nodeId, selection.onSelect) : undefined}
                disabled={!selection}
                aria-label={t("designer.problems.jumpTo", { name: problem.nodeName, message })}
              >
                <span className="problems-kind" data-kind={problem.kind}>
                  {t(KIND_LABEL[problem.kind])}
                </span>
                <span className="problems-node">{problem.nodeName}</span>
                <span className="problems-message">{message}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
