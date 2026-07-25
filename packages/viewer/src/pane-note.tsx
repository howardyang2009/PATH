/**
 * The two notes every read surface shows while a `Load` is not yet a value. Shared so the panes
 * phrase loading and failure identically — the wording, the muted/alert styling and the `role`
 * that announces a failure are decided once, not per surface.
 *
 * `what` names the thing being read, lower-case, and reads inside the sentence: "runs", "run",
 * "input".
 */
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
