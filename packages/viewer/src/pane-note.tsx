/** The shared loading/failure notes; `what` names the thing read, lower-case ("runs", "run", "input"). */
export function PaneLoading({ what }: { what: string }) {
  return <p className="pane-note">Loading {what}…</p>;
}

export function PaneError({ what, message }: { what: string; message: string }) {
  return (
    <p className="pane-note pane-error" role="alert">
      Failed to load {what}: {message}
    </p>
  );
}
