/**
 * The `assignee` of an awaiting `person-activity` step as a chip (CONTEXT.md § Person-activity). The
 * assignee is **informational** — no enforcement, no identity binding in v1 — so the chip only labels
 * who the activity is for; it never gates the Complete action. Shared by the run rail (on an awaiting
 * leaf) and the detail panel, so the two read identically.
 */
export function AssigneeChip({ assignee }: { assignee: string }) {
  return (
    <span className="assignee-chip" data-testid="assignee-chip" title={`Assigned to ${assignee}`}>
      <span className="assignee-avatar" aria-hidden="true">
        {assignee.slice(0, 2).toUpperCase()}
      </span>
      {assignee}
    </span>
  );
}
