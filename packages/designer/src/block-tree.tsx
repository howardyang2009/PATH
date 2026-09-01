import type { CSSProperties } from "react";
import type { WorkflowNode } from "@path/schema";
import { summarizeCondition } from "./condition-summary.js";

/**
 * The read-only block-grammar render of a `path/workflow` body (#367, designer-spec § The model: inline
 * within a file). Every node is a block: the three block logicers (`parallel`, `branch`, `while-do`) are
 * C-shaped wrappers whose arms and body nest in the mouth; a `sequence` is a vertical inline stack; a
 * leaf `step` is a chip; a `workflow`-ref is its own-hue chip, the one node a double-click descends
 * across (§ Structure on the canvas). Nesting **inside** a file is always visible — the canvas never
 * descends into a block, only across a ref boundary. No editing yet: the canvas shows structure and the
 * spec's read-only summaries (`join:`, `when`, `while … · max N`, `assert`) and nothing more.
 */

/** A `workflow`-ref descent request: the ref path to cross to, resolved by the caller against this file. */
export type DescendHandler = (ref: string) => void;

/** The file body: a vertical stack of blocks, the root of the render. */
export function BlockTree({ nodes, onDescend }: { nodes: WorkflowNode[]; onDescend: DescendHandler }): JSX.Element {
  return (
    <ul className="block-stack" role="list">
      {nodes.map((node) => (
        <li key={node.id}>
          <NodeBlock node={node} onDescend={onDescend} />
        </li>
      ))}
    </ul>
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
      // `prompt`, `binary`, and any plugin leaf type all render on the step hue.
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

function NodeBlock({ node, onDescend }: { node: WorkflowNode; onDescend: DescendHandler }): JSX.Element {
  switch (node.type) {
    case "workflow":
      return <RefChip node={node} onDescend={onDescend} />;
    case "parallel":
      return <ParallelBlock node={node} onDescend={onDescend} />;
    case "branch":
      return <BranchBlock node={node} onDescend={onDescend} />;
    case "while-do":
      return <WhileBlock node={node} onDescend={onDescend} />;
    case "sequence":
      return <SequenceBlock node={node} onDescend={onDescend} />;
    case "checkpoint":
      return <CheckpointBlock node={node} />;
    default:
      return <LeafStep node={node} />;
  }
}

/** A leaf `step` — a chip block, its kind named by the `LLM` / `COMMAND` / plugin-type chip. */
function LeafStep({ node }: { node: Exclude<WorkflowNode, { type: "workflow" | "parallel" | "branch" | "while-do" | "sequence" | "checkpoint" }> }): JSX.Element {
  return (
    <div className="node-block leaf" style={hueStyle(node)} data-node-type={node.type}>
      <span className="chip">{leafChip(node.type)}</span>
      <span className="node-name">{node.name}</span>
    </div>
  );
}

/** A `workflow`-ref — its own-hue chip showing the ref path, the one block a double-click descends across. */
function RefChip({ node, onDescend }: { node: Extract<WorkflowNode, { type: "workflow" }>; onDescend: DescendHandler }): JSX.Element {
  return (
    <div
      className="node-block leaf ref-chip"
      style={hueStyle(node)}
      data-node-type="workflow"
      role="button"
      tabIndex={0}
      title="Double-click to open the referenced file"
      onDoubleClick={() => onDescend(node.ref)}
    >
      <span className="chip">WORKFLOW</span>
      <span className="node-name">{node.name}</span>
      <span className="ref-path">{node.ref}</span>
    </div>
  );
}

/** A `checkpoint` — a leaf block inline in the stack, showing its `assert <cond>` summary. */
function CheckpointBlock({ node }: { node: Extract<WorkflowNode, { type: "checkpoint" }> }): JSX.Element {
  return (
    <div className="node-block leaf" style={hueStyle(node)} data-node-type="checkpoint">
      <span className="chip">CHECKPOINT</span>
      <span className="node-name">{node.name}</span>
      <span className="summary">assert {summarizeCondition(node.condition)}</span>
    </div>
  );
}

/** The C-block shell: a titled head (hue + name + optional summary/badge) over a mouth that nests children. */
function CBlock({
  node,
  head,
  children,
}: {
  node: WorkflowNode;
  head: JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className="node-block c-block" style={hueStyle(node)} data-node-type={node.type}>
      <div className="c-head">{head}</div>
      <div className="c-mouth">{children}</div>
    </div>
  );
}

/** `parallel` — a C-block, its N branches side by side in the mouth, with a `join:` badge on the head. */
function ParallelBlock({ node, onDescend }: { node: Extract<WorkflowNode, { type: "parallel" }>; onDescend: DescendHandler }): JSX.Element {
  return (
    <CBlock
      node={node}
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
            <NodeBlock node={branch} onDescend={onDescend} />
          </div>
        ))}
      </div>
    </CBlock>
  );
}

/** `branch` — a C-block, its N arms side by side (each with a `when <cond>` head), then the optional `else`. */
function BranchBlock({ node, onDescend }: { node: Extract<WorkflowNode, { type: "branch" }>; onDescend: DescendHandler }): JSX.Element {
  return (
    <CBlock
      node={node}
      head={
        <>
          <span className="kind-tag">branch</span>
          <span className="node-name">{node.name}</span>
        </>
      }
    >
      <div className="c-columns">
        {node.arms.map((arm) => (
          <div className="c-column" key={arm.node.id}>
            <span className="col-caption summary">when {summarizeCondition(arm.when)}</span>
            <NodeBlock node={arm.node} onDescend={onDescend} />
          </div>
        ))}
        {node.else ? (
          <div className="c-column">
            <span className="col-caption">else</span>
            <NodeBlock node={node.else} onDescend={onDescend} />
          </div>
        ) : null}
      </div>
    </CBlock>
  );
}

/** `while-do` — a C-block wrapping one body node, with a `while <cond> · max N` summary on the head. */
function WhileBlock({ node, onDescend }: { node: Extract<WorkflowNode, { type: "while-do" }>; onDescend: DescendHandler }): JSX.Element {
  return (
    <CBlock
      node={node}
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
      <NodeBlock node={node.node} onDescend={onDescend} />
    </CBlock>
  );
}

/** `sequence` — a vertical inline stack of its body nodes (its own level, not collapsed). */
function SequenceBlock({ node, onDescend }: { node: Extract<WorkflowNode, { type: "sequence" }>; onDescend: DescendHandler }): JSX.Element {
  return (
    <CBlock
      node={node}
      head={
        <>
          <span className="kind-tag">sequence</span>
          <span className="node-name">{node.name}</span>
        </>
      }
    >
      <BlockTree nodes={node.body} onDescend={onDescend} />
    </CBlock>
  );
}
