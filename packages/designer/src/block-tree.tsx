import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { WorkflowNode } from "@path/schema";
import { summarizeCondition } from "./condition-summary.js";
import { ConflictMarker } from "./conflict-context.js";
import type { EditorApi } from "./editor-api.js";
import type { SingleSlot } from "./edit-tree.js";
import { RUN_STATUS_GLYPH } from "./run/run-status.js";
import { useNodeRunStatus } from "./run/run-projection.js";
import { useSelection } from "./selection-context.js";

/**
 * The block-grammar render of a `path/workflow` body. Read-only in #367; **editable** in #368 when an
 * `editor` is threaded through (designer-spec § Structure on the canvas). Structure edits live on the
 * canvas, so the block carries the structure affordances — reorder (▲/▼), duplicate, delete (×, or the
 * Delete key), the tail add-socket of each list, the single-slot swap, and a branch's add-arm /
 * add-`else`. Where the grammar refuses the armed kind, no socket opens, so an illegal drop is
 * unreachable rather than rejected on save. Content (names, conditions, payloads) stays read-only here —
 * it graduates to the properties pane in a later ticket.
 */

/**
 * A double-click on a `workflow`-ref block. The caller decides by the node's `ref`: a **set** ref
 * descends across the boundary (resolving the path against this file); an **empty** ref (a step just
 * swapped in, not yet pointed anywhere) opens the ref-target chooser to author or pick its target
 * instead — so a fresh `workflow` block is authorable by double-click, not a dead descent into `""`.
 */
export type DescendHandler = (node: Extract<WorkflowNode, { type: "workflow" }>) => void;

/** A list socket the tree can grow: the file body (`ownerId` `null`) or a `sequence`/`parallel` owner. */
interface ListSocket {
  ownerId: string | null;
  flavor: "sequence" | "branches";
}

interface TreeProps {
  nodes: WorkflowNode[];
  onDescend: DescendHandler;
  /** Present when the canvas is editable (#368); absent for a pure read-only render. */
  editor?: EditorApi;
}

/** The file body (or a `sequence` body): a vertical stack of blocks, with the list's tail add-socket. */
export function BlockTree({ nodes, onDescend, editor, socket }: TreeProps & { socket?: ListSocket }): JSX.Element {
  return (
    <div className="block-stack-wrap">
      <ul className="block-stack" role="list">
        {nodes.map((node) => (
          <li key={node.id}>
            <NodeBlock node={node} onDescend={onDescend} editor={editor} />
          </li>
        ))}
      </ul>
      {socket ? <TailSocket socket={socket} editor={editor} /> : null}
    </div>
  );
}

/** The tail add-affordance of a list socket, shown only while the grammar admits the armed kind. */
function TailSocket({ socket, editor }: { socket: ListSocket; editor?: EditorApi }): JSX.Element | null {
  if (!editor || !editor.socketOpen(socket.flavor)) return null;
  return (
    <button type="button" className="socket socket-tail" onClick={() => editor.placeIntoList(socket.ownerId)}>
      + add {editor.armedKind} here
    </button>
  );
}

/** The hue-token key (`--k-<kind>`) for a node kind. Leaf steps share the step hue; the ref keeps its own. */
function hueKind(node: WorkflowNode): string {
  switch (node.type) {
    case "workflow":
      return "workflow";
    case "parallel":
      return "parallel";
    case "branch":
      return "branch";
    case "while-do":
      return "while";
    case "sequence":
      return "sequence";
    case "checkpoint":
      return "checkpoint";
    default:
      return "step";
  }
}

/** The block's CSS custom properties, so its border and mouth tint pick up its kind's hue tokens. */
function hueStyle(node: WorkflowNode): CSSProperties {
  const kind = hueKind(node);
  return { "--block-fg": `var(--k-${kind})`, "--block-bg": `var(--k-${kind}-bg)` } as CSSProperties;
}

/** The chip label for a leaf step: `LLM` for a prompt, `COMMAND` for a binary, else the type upper-cased. */
function leafChip(type: string): string {
  if (type === "prompt") return "LLM";
  if (type === "binary") return "COMMAND";
  return type.toUpperCase();
}

/** The per-node structure controls: reorder, duplicate, delete (§ Reordering, deleting). Only when editable. */
function NodeControls({ node, editor }: { node: WorkflowNode; editor?: EditorApi }): JSX.Element | null {
  if (!editor) return null;
  return (
    <span className="node-controls">
      {editor.canMove(node.id) ? (
        <>
          <button type="button" className="ctl" aria-label={`Move ${node.name} up`} onClick={() => editor.move(node.id, -1)}>
            ▲
          </button>
          <button type="button" className="ctl" aria-label={`Move ${node.name} down`} onClick={() => editor.move(node.id, 1)}>
            ▼
          </button>
        </>
      ) : null}
      {editor.canDuplicate(node.id) ? (
        <button type="button" className="ctl" aria-label={`Duplicate ${node.name}`} onClick={() => editor.duplicate(node.id)}>
          ⧉
        </button>
      ) : null}
      {editor.canRemove(node.id) ? (
        <button type="button" className="ctl ctl-del" aria-label={`Delete ${node.name}`} onClick={() => editor.remove(node.id)}>
          ×
        </button>
      ) : null}
    </span>
  );
}

/** The Delete/Backspace handler for a focused block — the keyboard peer of the × control (§ Delete). */
function deleteKeyHandler(node: WorkflowNode, editor?: EditorApi) {
  return (event: KeyboardEvent): void => {
    if (!editor) return;
    // Delete or Backspace (#389): the undo stack now backs a destructive subtree delete, so Backspace —
    // withheld before for want of an undo — is unlocked and is itself undoable (via `editor.remove`).
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (event.target !== event.currentTarget) return; // ignore keys bubbling from a nested control
    if (!editor.canRemove(node.id)) return;
    event.preventDefault();
    editor.remove(node.id);
  };
}

/**
 * The single-click selection props for a block (#369): a click reports the node's id to the selection
 * context (populating the properties pane), unless it landed on a control or socket button — those own
 * their action and must not also select. A selected block carries `data-selected` for the highlight. On
 * a read-only render (no selection context, e.g. #367) it returns nothing, so the block stays inert.
 */
function useSelectable(node: WorkflowNode): { "data-node-id": string; "data-selected"?: "true"; onClick?: (event: MouseEvent) => void } {
  const selection = useSelection();
  // `data-node-id` rides on every block regardless of edit mode, so the problems panel's jump-to-node
  // (#388) can scroll the offending block into view whether or not it is the selected one.
  if (!selection) return { "data-node-id": node.id };
  return {
    "data-node-id": node.id,
    "data-selected": selection.selectedId === node.id ? "true" : undefined,
    onClick: (event: MouseEvent): void => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.stopPropagation();
      selection.onSelect(node.id);
    },
  };
}

/**
 * The canvas run projection for one node (#372, surface 6): a status glyph+label badge when the watched
 * run touched this node. One node produces many runs, so the fold is `run-projection.ts`'s; this only
 * draws the folded status. Absent when no run is watched or the node has not run — the block then reads
 * exactly as it did before a run was selected. `data-run-status` tints the badge from the stylesheet.
 */
function NodeRunBadge({ id }: { id: string }): JSX.Element | null {
  const status = useNodeRunStatus(id);
  if (status === null) return null;
  return (
    <span className="node-run-badge" data-run-status={status} data-testid={`node-run-badge-${id}`}>
      <span className="node-run-badge-glyph" aria-hidden="true">
        {RUN_STATUS_GLYPH[status]}
      </span>
      {status}
    </span>
  );
}

function NodeBlock({ node, onDescend, editor }: { node: WorkflowNode; onDescend: DescendHandler; editor?: EditorApi }): JSX.Element {
  switch (node.type) {
    case "workflow":
      return <RefChip node={node} onDescend={onDescend} editor={editor} />;
    case "parallel":
      return <ParallelBlock node={node} onDescend={onDescend} editor={editor} />;
    case "branch":
      return <BranchBlock node={node} onDescend={onDescend} editor={editor} />;
    case "while-do":
      return <WhileBlock node={node} onDescend={onDescend} editor={editor} />;
    case "sequence":
      return <SequenceBlock node={node} onDescend={onDescend} editor={editor} />;
    case "checkpoint":
      return <CheckpointBlock node={node} editor={editor} />;
    default:
      return <LeafStep node={node} editor={editor} />;
  }
}

/** A leaf `step` — a chip block, its kind named by the `LLM` / `COMMAND` / plugin-type chip. */
function LeafStep({ node, editor }: { node: WorkflowNode; editor?: EditorApi }): JSX.Element {
  return (
    <div
      className="node-block leaf"
      style={hueStyle(node)}
      data-node-type={node.type}
      tabIndex={editor ? 0 : undefined}
      onKeyDown={deleteKeyHandler(node, editor)}
      {...useSelectable(node)}
    >
      <span className="chip">{leafChip(node.type)}</span>
      <span className="node-name">{node.name}</span>
      <NodeRunBadge id={node.id} />
      <ConflictMarker id={node.id} />
      <NodeControls node={node} editor={editor} />
    </div>
  );
}

/** A `workflow`-ref — its own-hue chip showing the ref path, the one block a double-click descends across. */
function RefChip({ node, onDescend, editor }: { node: Extract<WorkflowNode, { type: "workflow" }>; onDescend: DescendHandler; editor?: EditorApi }): JSX.Element {
  return (
    <div
      className="node-block leaf ref-chip"
      style={hueStyle(node)}
      data-node-type="workflow"
      role="button"
      tabIndex={0}
      title={node.ref ? "Double-click to open the referenced file" : "Double-click to choose or create this reference's target"}
      onDoubleClick={() => onDescend(node)}
      onKeyDown={deleteKeyHandler(node, editor)}
      {...useSelectable(node)}
    >
      <span className="chip">WORKFLOW</span>
      <span className="node-name">{node.name}</span>
      <span className="ref-path">{node.ref}</span>
      <NodeRunBadge id={node.id} />
      <ConflictMarker id={node.id} />
      <NodeControls node={node} editor={editor} />
    </div>
  );
}

/** A `checkpoint` — a leaf block inline in the stack, showing its `assert <cond>` summary. */
function CheckpointBlock({ node, editor }: { node: Extract<WorkflowNode, { type: "checkpoint" }>; editor?: EditorApi }): JSX.Element {
  return (
    <div
      className="node-block leaf"
      style={hueStyle(node)}
      data-node-type="checkpoint"
      tabIndex={editor ? 0 : undefined}
      onKeyDown={deleteKeyHandler(node, editor)}
      {...useSelectable(node)}
    >
      <span className="chip">CHECKPOINT</span>
      <span className="node-name">{node.name}</span>
      <span className="summary">assert {summarizeCondition(node.condition)}</span>
      <NodeRunBadge id={node.id} />
      <ConflictMarker id={node.id} />
      <NodeControls node={node} editor={editor} />
    </div>
  );
}

/** The C-block shell: a titled head (hue + name + controls) over a mouth that nests children. */
function CBlock({ node, head, editor, children }: { node: WorkflowNode; head: JSX.Element; editor?: EditorApi; children: ReactNode }): JSX.Element {
  return (
    <div
      className="node-block c-block"
      style={hueStyle(node)}
      data-node-type={node.type}
      tabIndex={editor ? 0 : undefined}
      onKeyDown={deleteKeyHandler(node, editor)}
      {...useSelectable(node)}
    >
      <div className="c-head">
        {head}
        <NodeRunBadge id={node.id} />
        <ConflictMarker id={node.id} />
        <NodeControls node={node} editor={editor} />
      </div>
      <div className="c-mouth">{children}</div>
    </div>
  );
}

/** The single-slot swap affordance: an armed, single-legal kind can replace an occupant (§ Replace). */
function SlotSwap({ target, editor }: { target: SingleSlot; editor?: EditorApi }): JSX.Element | null {
  if (!editor || !editor.socketOpen("single")) return null;
  return (
    <button type="button" className="socket socket-swap" onClick={() => editor.swapSingle(target)}>
      swap for {editor.armedKind}
    </button>
  );
}

/** `parallel` — a C-block, its N branches side by side in the mouth, with a `join:` badge on the head. */
function ParallelBlock({ node, onDescend, editor }: { node: Extract<WorkflowNode, { type: "parallel" }>; onDescend: DescendHandler; editor?: EditorApi }): JSX.Element {
  const branchSocketOpen = editor?.socketOpen("branches") ?? false;
  return (
    <CBlock
      node={node}
      editor={editor}
      head={
        <>
          <span className="kind-tag">parallel</span>
          <span className="node-name">{node.name}</span>
          <span className="badge">join: {node.join}</span>
        </>
      }
    >
      <div className="c-columns">
        {node.branches.map((branch) => (
          <div className="c-column" key={branch.id}>
            <span className="col-caption">{branch.name}</span>
            <NodeBlock node={branch} onDescend={onDescend} editor={editor} />
          </div>
        ))}
        {branchSocketOpen ? (
          <div className="c-column">
            <button type="button" className="socket socket-tail" onClick={() => editor!.placeIntoList(node.id)}>
              + add {editor!.armedKind} branch
            </button>
          </div>
        ) : null}
      </div>
    </CBlock>
  );
}

/** `branch` — a C-block, its N arms side by side (each `when <cond>`), then `else`, then the add affordances. */
function BranchBlock({ node, onDescend, editor }: { node: Extract<WorkflowNode, { type: "branch" }>; onDescend: DescendHandler; editor?: EditorApi }): JSX.Element {
  return (
    <CBlock
      node={node}
      editor={editor}
      head={
        <>
          <span className="kind-tag">branch</span>
          <span className="node-name">{node.name}</span>
        </>
      }
    >
      <div className="c-columns">
        {node.arms.map((arm, armIndex) => (
          <div className="c-column" key={arm.node.id}>
            <span className="col-caption summary">when {summarizeCondition(arm.when)}</span>
            <NodeBlock node={arm.node} onDescend={onDescend} editor={editor} />
            <SlotSwap target={{ slot: "arm", ownerId: node.id, armIndex }} editor={editor} />
          </div>
        ))}
        {node.else ? (
          <div className="c-column">
            <span className="col-caption">else</span>
            <NodeBlock node={node.else} onDescend={onDescend} editor={editor} />
            <SlotSwap target={{ slot: "else", ownerId: node.id }} editor={editor} />
          </div>
        ) : null}
      </div>
      {editor ? (
        <div className="block-affordances">
          <button type="button" className="socket" onClick={() => editor.addArm(node.id)}>
            + add arm
          </button>
          {node.else ? null : (
            <button type="button" className="socket" onClick={() => editor.addElse(node.id)}>
              + add else
            </button>
          )}
        </div>
      ) : null}
    </CBlock>
  );
}

/** `while-do` — a C-block wrapping one body node, with a `while <cond> · max N` summary on the head. */
function WhileBlock({ node, onDescend, editor }: { node: Extract<WorkflowNode, { type: "while-do" }>; onDescend: DescendHandler; editor?: EditorApi }): JSX.Element {
  return (
    <CBlock
      node={node}
      editor={editor}
      head={
        <>
          <span className="kind-tag">while-do</span>
          <span className="node-name">{node.name}</span>
          <span className="summary">
            while {summarizeCondition(node.condition)} · max {node.max_iterations}
          </span>
        </>
      }
    >
      <NodeBlock node={node.node} onDescend={onDescend} editor={editor} />
      <SlotSwap target={{ slot: "while-body", ownerId: node.id }} editor={editor} />
    </CBlock>
  );
}

/** `sequence` — a vertical inline stack of its body nodes (its own level, not collapsed). */
function SequenceBlock({ node, onDescend, editor }: { node: Extract<WorkflowNode, { type: "sequence" }>; onDescend: DescendHandler; editor?: EditorApi }): JSX.Element {
  return (
    <CBlock
      node={node}
      editor={editor}
      head={
        <>
          <span className="kind-tag">sequence</span>
          <span className="node-name">{node.name}</span>
        </>
      }
    >
      <BlockTree nodes={node.body} onDescend={onDescend} editor={editor} socket={{ ownerId: node.id, flavor: "sequence" }} />
    </CBlock>
  );
}
