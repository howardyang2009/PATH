/** The awaiting step's `assignee` as a chip; informational only, it never gates Complete. */
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
