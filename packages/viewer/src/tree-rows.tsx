/** The left indent of one tree row at `depth`, in px — a folder step per level, over the row's base
 * pad. Every Discovery tree, the Viewer's and the Designer's pickers, indents by it. */
export function indent(depth: number): React.CSSProperties {
  return { paddingLeft: 8 + depth * 14 };
}

/** One folder in a Discovery tree: a navigation step. Clicking it walks in (expands its level) or
 * back out. */
export function FolderRow({
  name,
  path,
  count,
  depth,
  open,
  onToggle,
}: {
  name: string;
  /** The folder's tree path, its test id. */
  path: string;
  /** The number of files anywhere under the folder. */
  count: number;
  depth: number;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="workflow-folder-row"
      data-testid={`workflow-folder-${path}`}
      aria-expanded={open}
      onClick={onToggle}
      style={indent(depth)}
    >
      <span className="workflow-folder-chevron" aria-hidden="true">
        {open ? "▾" : "▸"}
      </span>
      <span className="workflow-folder-name">{name}</span>
      <span className="workflow-folder-count">{count}</span>
    </button>
  );
}
