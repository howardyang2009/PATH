import { useSelection } from "./selection-context.js";
import type { Problem, ProblemKind } from "./problems.js";

/**
 * The aggregate problems panel (#388, designer-spec § Canvas validation-error UX). The per-node ⚠
 * marker and this panel are **two coupled surfaces**: a marker on a collapsed or off-screen node is
 * invisible, and a marker alone makes the author hunt — so every current cross-node error is listed
 * here too, each row jumping to its node.
 *
 * These are **soft** errors — they do not block save (§ save-with-warnings). The panel states that
 * plainly, so a warning count is read as "launch knowingly", never as "the file is broken".
 */

/** The short tag each row wears, naming which check flagged it. */
const KIND_LABEL: Record<ProblemKind, string> = {
  "publish-conflict": "publish",
  "dangling-interpolation": "context read",
  "dangling-condition": "condition",
  "dangling-ref": "ref",
};

/** Select the node and scroll its block into view — the panel's jump-to-node. */
function jumpTo(nodeId: string, onSelect: (id: string) => void): void {
  onSelect(nodeId);
  const block = document.querySelector(`[data-node-id="${nodeId}"]`);
  // `scrollIntoView` is absent under jsdom; the select above is the load-bearing half a test asserts.
  block?.scrollIntoView?.({ block: "center", behavior: "smooth" });
}

export function ProblemsPanel({ problems }: { problems: Problem[] }): JSX.Element | null {
  const selection = useSelection();
  if (problems.length === 0) return null;

  const count = problems.length;
  return (
    <section className="problems-panel" role="region" aria-label="Problems">
      <header className="problems-head">
        <span className="problems-title" role="img" aria-label={`${count} warning${count === 1 ? "" : "s"}`}>
          ⚠ {count} {count === 1 ? "warning" : "warnings"}
        </span>
        <span className="problems-note">Soft errors — save and launch are not blocked.</span>
      </header>
      <ul className="problems-list" role="list">
        {problems.map((problem, index) => (
          <li className="problems-row" key={`${problem.nodeId}:${problem.kind}:${index}`}>
            <button
              type="button"
              className="problems-jump"
              data-testid={`problem-jump-${problem.nodeId}`}
              onClick={selection ? () => jumpTo(problem.nodeId, selection.onSelect) : undefined}
              disabled={!selection}
              aria-label={`Jump to ${problem.nodeName}: ${problem.message}`}
            >
              <span className="problems-kind" data-kind={problem.kind}>
                {KIND_LABEL[problem.kind]}
              </span>
              <span className="problems-node">{problem.nodeName}</span>
              <span className="problems-message">{problem.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
